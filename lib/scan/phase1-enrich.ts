import { SupabaseClient } from '@supabase/supabase-js';
import { getProjectMemberCount } from '@/lib/aps/admin';
import { limits, withRetry } from './rate-limiter';

const BATCH_SIZE = 50;

export async function runPhase1Batch(
  db: SupabaseClient,
  jobId: string,
  accountId: string,
  token: string,
  cursor: string | null
): Promise<{ done: boolean; next_cursor: string | null; scanned: number }> {
  // Load one batch of pending projects after cursor
  const query = db
    .from('projects')
    .select('id, acc_project_id')
    .eq('scan_job_id', jobId)
    .eq('scan_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (cursor) query.gt('acc_project_id', cursor);

  const { data: batch } = await query;
  if (!batch || batch.length === 0) return { done: true, next_cursor: null, scanned: 0 };

  await Promise.all(
    batch.map(p =>
      limits.phase1(async () => {
        const memberCount = await withRetry(() =>
          getProjectMemberCount(accountId, p.acc_project_id, token)
        ).catch(() => 0);

        await db.from('projects').update({
          member_count: memberCount,
          scan_status: 'pending', // still pending for phase 2
        }).eq('id', p.id);
      })
    )
  );

  const lastId = batch[batch.length - 1].acc_project_id;
  const { count: total } = await db
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('scan_job_id', jobId);

  const { count: done } = await db
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('scan_job_id', jobId)
    .neq('scan_status', 'pending');

  const scannedSoFar = done ?? 0;
  const pct = Math.round(5 + ((scannedSoFar / (total ?? 1)) * 25));

  await db.from('scan_jobs').update({
    phase_1_cursor: lastId,
    scanned_projects: scannedSoFar,
    overall_pct: pct,
    current_action: `Enriching projects (${scannedSoFar}/${total})…`,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);

  const isLast = batch.length < BATCH_SIZE;
  return { done: isLast, next_cursor: isLast ? null : lastId, scanned: batch.length };
}
