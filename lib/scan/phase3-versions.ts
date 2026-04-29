import { SupabaseClient } from '@supabase/supabase-js';
import { getManifestVersion } from '@/lib/aps/derivative';
import { limits, withRetry } from './rate-limiter';

const BATCH_SIZE = 50;
const DEPRECATED_BELOW = parseInt(process.env.NEXT_PUBLIC_DEPRECATED_BELOW_VERSION ?? '2022');

async function detectFromBinaryHeader(
  storageUrl: string,
  token: string
): Promise<string | null> {
  const res = await fetch(storageUrl, {
    headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-4096' },
  });
  if (!res.ok) return null;

  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const OLE2_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (!OLE2_SIG.every((b, i) => bytes[i] === b)) return null;

  const text = new TextDecoder('latin1').decode(buffer);
  const formatMatch = text.match(/Format:\s*(\d{4})/);
  if (formatMatch) return formatMatch[1];
  const buildMatch = text.match(/Autodesk Revit (\d{4})/);
  return buildMatch ? buildMatch[1] : null;
}

export async function runPhase3Batch(
  db: SupabaseClient,
  jobId: string,
  token: string,
  cursor: string | null
): Promise<{ done: boolean; next_cursor: string | null; detected: number }> {
  // Fetch project IDs for this scan job
  const { data: projectRows } = await db
    .from('projects')
    .select('id')
    .eq('scan_job_id', jobId);
  const projectIds = (projectRows ?? []).map(p => p.id);

  if (projectIds.length === 0) {
    await finalizeScan(db, jobId);
    return { done: true, next_cursor: null, detected: 0 };
  }

  // Files that need version detection (T0 already handled cloud models)
  const query = db
    .from('revit_files')
    .select('id, project_id, version_urn, file_name')
    .is('revit_version', null)
    .is('detection_method', null)
    .in('project_id', projectIds)
    .order('id', { ascending: true })
    .limit(BATCH_SIZE);

  if (cursor) query.gt('id', cursor);

  const { data: batch } = await query;
  if (!batch || batch.length === 0) {
    await finalizeScan(db, jobId);
    return { done: true, next_cursor: null, detected: 0 };
  }

  let detected = 0;

  await Promise.all(
    batch.map(file =>
      limits.phase3(async () => {
        let version: string | null = null;
        let method: string = 'unknown';

        // T1: Model Derivative manifest
        if (file.version_urn) {
          version = await withRetry(() =>
            getManifestVersion(file.version_urn!, token)
          ).catch(() => null);
          if (version) method = 'manifest';
        }

        // T2: Binary header (last resort for pre-2024 suspected files)
        // T3 (Design Automation) is stubbed — implement when DA setup wizard is built
        if (!version && file.version_urn) {
          // Binary header — only attempt for files that might be pre-2024
          // We can't know for sure without reading, so we attempt and verify OLE2 sig
          const storageUrl = `https://developer.api.autodesk.com/oss/v2/buckets/wip.dm.prod/objects/${encodeURIComponent(file.version_urn)}`;
          version = await withRetry(() =>
            detectFromBinaryHeader(storageUrl, token)
          ).catch(() => null);
          if (version) {
            // For 2024+ files the binary approach returns null (no OLE2 sig), so if
            // we got a result it's a pre-2024 file and the value is trustworthy.
            method = 'binary_header';
          }
        }

        const needsUpgrade =
          version !== null ? parseInt(version) < DEPRECATED_BELOW : null;

        await db.from('revit_files').update({
          revit_version: version,
          detection_method: method,
          needs_upgrade: needsUpgrade,
        }).eq('id', file.id);

        if (version) detected++;

        // Update project counters if at-risk
        if (needsUpgrade) {
          await db.rpc('increment_project_at_risk', { p_project_id: file.project_id });
        }
      })
    )
  );

  const lastId = batch[batch.length - 1].id;
  const isLast = batch.length < BATCH_SIZE;

  const { data: job } = await db
    .from('scan_jobs')
    .select('versions_detected, total_rvt_files, at_risk_count')
    .eq('id', jobId)
    .single();

  const newDetected = (job?.versions_detected ?? 0) + detected;

  await db.from('scan_jobs').update({
    versions_detected: newDetected,
    phase_3_cursor: lastId,
    overall_pct: isLast ? 100 : Math.round(70 + (newDetected / Math.max(job?.total_rvt_files ?? 1, 1)) * 30),
    current_action: `Detecting versions (${newDetected} processed)…`,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);

  if (isLast) await finalizeScan(db, jobId);

  return { done: isLast, next_cursor: isLast ? null : lastId, detected };
}

async function finalizeScan(db: SupabaseClient, jobId: string) {
  const { data: pRows } = await db.from('projects').select('id').eq('scan_job_id', jobId);
  const pIds = (pRows ?? []).map(p => p.id);

  const { count: atRisk } = await db
    .from('revit_files')
    .select('id', { count: 'exact', head: true })
    .eq('needs_upgrade', true)
    .in('project_id', pIds.length > 0 ? pIds : ['00000000-0000-0000-0000-000000000000']);

  await db.from('scan_jobs').update({
    status: 'completed',
    phase: 'done',
    overall_pct: 100,
    at_risk_count: atRisk ?? 0,
    current_action: 'Scan complete.',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);
}
