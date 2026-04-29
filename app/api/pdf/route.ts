export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { createElement } from 'react';
import { getTokenFromCookie } from '@/lib/aps/auth';
import { createServerClient } from '@/lib/supabase';
import { ScanReport } from '@/lib/pdf/report';

export async function GET(req: NextRequest) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

  const db = createServerClient();

  const { data: job } = await db.from('scan_jobs').select('*').eq('id', jobId).single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: settings } = await db
    .from('hub_settings').select('hub_name').eq('hub_id', job.hub_id).single();

  const { data: atRiskProjects } = await db
    .from('projects')
    .select('*')
    .eq('scan_job_id', jobId)
    .gt('at_risk_file_count', 0)
    .order('priority_score', { ascending: false });

  const filesPerProject: Record<string, unknown[]> = {};
  for (const p of (atRiskProjects ?? [])) {
    const { data: files } = await db
      .from('revit_files')
      .select('file_name, folder_path, revit_version, detection_method, is_composite')
      .eq('project_id', p.id)
      .eq('needs_upgrade', true);
    filesPerProject[p.id] = files ?? [];
  }

  const membersImpacted = (atRiskProjects ?? []).reduce((s: number, p: { member_count: number }) => s + (p.member_count ?? 0), 0);

  const reportData = {
    hubName: settings?.hub_name ?? job.hub_id,
    scanDate: job.completed_at
      ? new Date(job.completed_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'N/A',
    totalProjects: job.total_projects ?? 0,
    atRiskProjects: atRiskProjects ?? [],
    filesPerProject,
    totalFiles: job.total_rvt_files ?? 0,
    atRiskFiles: job.at_risk_count ?? 0,
    membersImpacted,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(createElement(ScanReport as any, { data: reportData }) as any);
  const uint8 = new Uint8Array(buffer);

  return new NextResponse(uint8, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="c4r-scanner-report-${new Date().toISOString().slice(0, 10)}.pdf"`,
    },
  });
}