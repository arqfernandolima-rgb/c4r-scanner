import { SupabaseClient } from '@supabase/supabase-js';
import { getTopFolders, getFolderContents, getItemVersions } from '@/lib/aps/dm';
import { limits, withRetry } from './rate-limiter';
import { computePriorityScore } from '@/lib/priority';

const PROJECTS_PER_BATCH = 5;
const DEPRECATED_BELOW = parseInt(process.env.NEXT_PUBLIC_DEPRECATED_BELOW_VERSION ?? '2022');

interface RevitFileRow {
  project_id: string;
  item_id: string;
  version_urn: string | null;
  file_name: string;
  folder_path: string;
  revit_version: string | null;
  detection_method: string | null;
  is_cloud_model: boolean;
  is_composite: boolean;
  composite_parent_file: string | null;
  has_linked_files: boolean;
  linked_file_count: number;
  needs_upgrade: boolean | null;
  last_modified_at: string | null;
  file_size_bytes: number | null;
}

async function traverseFolder(
  projectId: string,
  folderId: string,
  folderPath: string,
  token: string,
  db: SupabaseClient,
  dbProjectId: string,
  files: RevitFileRow[]
): Promise<void> {
  const { folders, items } = await withRetry(() =>
    getFolderContents(projectId, folderId, token)
  );

  const rvtItems = items.filter(i =>
    i.attributes.displayName?.toLowerCase().endsWith('.rvt')
  );

  for (const item of rvtItems) {
    // T0: check version extension data (free, already in the item attributes)
    const versions = await withRetry(() => getItemVersions(projectId, item.id, token)).catch(() => []);
    const latestVersion = versions[0];
    const ext = latestVersion?.extension;

    let revitVersion: string | null = null;
    let detectionMethod: string | null = null;
    let isCloudModel = false;
    let isComposite = false;
    let compositeParentFile: string | null = null;
    let hasLinkedFiles = false;
    let linkedFileCount = 0;

    if (ext?.type === 'versions:autodesk.bim360:C4RModel') {
      isCloudModel = true;
      const extData = ext.data;
      if (extData?.revitProjectVersion) {
        revitVersion = String(extData.revitProjectVersion);
        detectionMethod = 'dm_extension';
      }
      if (extData?.isCompositeDesign) {
        isComposite = true;
        compositeParentFile = (extData.compositeParentFile as string) ?? null;
      }
    }

    // Check if this file is a host with links (extension data may expose this)
    if ((ext?.data as Record<string, unknown>)?.['linkedDocuments']) {
      hasLinkedFiles = true;
      const linked = (ext?.data as Record<string, unknown>)['linkedDocuments'];
      linkedFileCount = Array.isArray(linked) ? linked.length : 0;
    }

    const needsUpgrade =
      revitVersion !== null
        ? parseInt(revitVersion) < DEPRECATED_BELOW
        : null;

    files.push({
      project_id: dbProjectId,
      item_id: item.id,
      version_urn: (item.relationships?.storage?.data?.id) ?? null,
      file_name: item.attributes.displayName,
      folder_path: folderPath,
      revit_version: revitVersion,
      detection_method: detectionMethod,
      is_cloud_model: isCloudModel,
      is_composite: isComposite,
      composite_parent_file: compositeParentFile,
      has_linked_files: hasLinkedFiles,
      linked_file_count: linkedFileCount,
      needs_upgrade: needsUpgrade,
      last_modified_at: latestVersion?.lastModifiedTime ?? item.attributes.lastModifiedTime ?? null,
      file_size_bytes: (latestVersion?.storageSize as number) ?? null,
    });
  }

  // Recurse into subfolders concurrently (bounded by phase2 limit)
  await Promise.all(
    folders.map(f =>
      limits.phase2(() =>
        traverseFolder(
          projectId,
          f.id,
          `${folderPath}/${f.attributes.displayName}`,
          token,
          db,
          dbProjectId,
          files
        )
      )
    )
  );
}

export async function runPhase2Batch(
  db: SupabaseClient,
  jobId: string,
  hubId: string,
  token: string
): Promise<{ done: boolean; filesFound: number }> {
  // Pick next batch of projects that haven't been file-scanned
  const { data: batch } = await db
    .from('projects')
    .select('id, acc_project_id, name')
    .eq('scan_job_id', jobId)
    .eq('scan_status', 'pending')
    .limit(PROJECTS_PER_BATCH);

  if (!batch || batch.length === 0) {
    await db.from('scan_jobs').update({
      phase: 'versions',
      overall_pct: 70,
      current_action: 'File discovery complete. Detecting versions…',
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);
    return { done: true, filesFound: 0 };
  }

  let totalNewFiles = 0;

  await Promise.all(
    batch.map(p =>
      limits.phase2(async () => {
        await db.from('projects').update({ scan_status: 'scanning' }).eq('id', p.id);

        try {
          // DM API requires the `b.` prefix; Admin API returns plain UUIDs
          const dmProjectId = p.acc_project_id.startsWith('b.')
            ? p.acc_project_id
            : `b.${p.acc_project_id}`;

          const topFolders = await withRetry(() => getTopFolders(hubId, dmProjectId, token));
          const files: RevitFileRow[] = [];

          await Promise.all(
            topFolders.map(folder =>
              limits.phase2(() =>
                traverseFolder(
                  dmProjectId,
                  folder.id,
                  `/${folder.attributes.displayName}`,
                  token,
                  db,
                  p.id,
                  files
                )
              )
            )
          );

          if (files.length > 0) {
            const batchSize = 200;
            for (let i = 0; i < files.length; i += batchSize) {
              await db.from('revit_files').insert(files.slice(i, i + batchSize));
            }
          }

          // Count at-risk (already detected via T0)
          const atRiskCount = files.filter(f => f.needs_upgrade === true).length;
          const hasComposite = files.some(f => f.is_composite);
          const compositeCount = files.filter(f => f.is_composite).length;
          const lastModified = files
            .map(f => f.last_modified_at)
            .filter(Boolean)
            .sort()
            .reverse()[0] ?? null;

          const minVersion = files
            .map(f => f.revit_version)
            .filter(Boolean)
            .sort((a, b) => parseInt(a!) - parseInt(b!))[0] ?? null;

          await db.from('projects').update({
            scan_status: 'completed',
            rvt_file_count: files.length,
            at_risk_file_count: atRiskCount,
            has_composite_files: hasComposite,
            composite_file_count: compositeCount,
            min_revit_version: minVersion,
            last_file_activity: lastModified,
            upgrade_status: files.length === 0 ? 'not_needed' : 'pending',
            scanned_at: new Date().toISOString(),
          }).eq('id', p.id);

          totalNewFiles += files.length;
        } catch (err: unknown) {
          const error = err as { status?: number; message?: string };
          const isForbidden = error?.status === 403;
          await db.from('projects').update({
            scan_status: 'error',
            scan_error: isForbidden ? 'Insufficient permissions' : (error?.message ?? 'Unknown error'),
          }).eq('id', p.id);
        }
      })
    )
  );

  // Recompute priority scores for all completed projects
  await recomputePriorityScores(db, jobId);

  const { count: remaining } = await db
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('scan_job_id', jobId)
    .eq('scan_status', 'pending');

  const { count: total } = await db
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('scan_job_id', jobId);

  const { data: job } = await db
    .from('scan_jobs')
    .select('total_rvt_files')
    .eq('id', jobId)
    .single();

  const newTotal = (job?.total_rvt_files ?? 0) + totalNewFiles;
  const done = (remaining ?? 0) === 0;
  const pct = done ? 70 : Math.round(30 + (((total ?? 1) - (remaining ?? 0)) / (total ?? 1)) * 40);

  await db.from('scan_jobs').update({
    total_rvt_files: newTotal,
    overall_pct: pct,
    current_action: done
      ? 'File discovery complete. Detecting versions…'
      : `Scanning folders… (${(remaining ?? 0)} projects remaining)`,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);

  return { done, filesFound: totalNewFiles };
}

async function recomputePriorityScores(db: SupabaseClient, jobId: string) {
  const { data: projects } = await db
    .from('projects')
    .select('id, member_count, at_risk_file_count, last_file_activity')
    .eq('scan_job_id', jobId)
    .eq('scan_status', 'completed');

  if (!projects || projects.length === 0) return;

  const maxMembers = Math.max(...projects.map(p => p.member_count ?? 0));
  const maxAtRisk = Math.max(...projects.map(p => p.at_risk_file_count ?? 0));

  await Promise.all(
    projects.map(p => {
      const score = computePriorityScore({
        member_count: p.member_count ?? 0,
        at_risk_file_count: p.at_risk_file_count ?? 0,
        last_file_activity: p.last_file_activity ? new Date(p.last_file_activity) : null,
        max_members: maxMembers,
        max_at_risk: maxAtRisk,
      });
      return db.from('projects').update({ priority_score: score }).eq('id', p.id);
    })
  );
}
