import { SupabaseClient } from '@supabase/supabase-js';
import { listAllProjects } from '@/lib/aps/admin';
import { withRetry } from './rate-limiter';

export async function runPhase0(
  db: SupabaseClient,
  jobId: string,
  hubId: string,
  accountId: string,
  token: string
): Promise<number> {
  await db.from('scan_jobs').update({ current_action: 'Enumerating projects…' }).eq('id', jobId);

  const allProjects = await withRetry(() => listAllProjects(accountId, token));

  // Skip archived/inactive projects — only scan active ones
  const projects = allProjects.filter(p =>
    !p.status || p.status.toLowerCase() === 'active'
  );

  const rows = projects.map(p => ({
    scan_job_id: jobId,
    acc_project_id: p.id,
    hub_id: hubId,
    name: p.name,
    project_type: p.type ?? 'ACC',
    status: p.status ?? 'active',
    scan_status: 'pending',
  }));

  if (rows.length > 0) {
    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      await db.from('projects').insert(rows.slice(i, i + batchSize));
    }
  }

  await db.from('scan_jobs').update({
    total_projects: projects.length,
    phase: 'projects',
    phase_0_cursor: 'done',
    overall_pct: 5,
    current_action: `Found ${projects.length} active projects (${allProjects.length - projects.length} archived skipped). Enriching…`,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId);

  return projects.length;
}
