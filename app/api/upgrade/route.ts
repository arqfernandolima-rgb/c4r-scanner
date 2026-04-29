export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromCookie } from '@/lib/aps/auth';
import { createServerClient } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const hubId = searchParams.get('hubId');

  const db = createServerClient();

  // Get latest scan's at-risk projects with upgrade tasks
  const { data: latest } = await db
    .from('scan_jobs')
    .select('id')
    .eq('hub_id', hubId ?? '')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
    .single();

  if (!latest) return NextResponse.json({ tasks: [] });

  const { data: projects } = await db
    .from('projects')
    .select('*, upgrade_tasks(*)')
    .eq('scan_job_id', latest.id)
    .gt('at_risk_file_count', 0)
    .order('priority_score', { ascending: false });

  return NextResponse.json({ tasks: projects ?? [] });
}

export async function POST(req: NextRequest) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId, status, assignedTo, targetVersion, notes } = await req.json();
  const db = createServerClient();

  // Upsert upgrade task
  const { data: existing } = await db
    .from('upgrade_tasks')
    .select('id')
    .eq('project_id', projectId)
    .limit(1)
    .single();

  if (existing) {
    await db.from('upgrade_tasks').update({
      status: status ?? 'pending',
      assigned_to: assignedTo,
      target_version: targetVersion,
      notes,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id);
  } else {
    const { data: project } = await db
      .from('projects')
      .select('acc_project_id')
      .eq('id', projectId)
      .single();

    const accId = project?.acc_project_id?.replace(/^b\./, '');
    const accUpgradeUrl = accId
      ? `https://acc.autodesk.com/docs/files/projects/${accId}?upgrade=true`
      : null;

    await db.from('upgrade_tasks').insert({
      project_id: projectId,
      status: status ?? 'pending',
      assigned_to: assignedTo,
      target_version: targetVersion,
      notes,
      acc_upgrade_url: accUpgradeUrl,
    });
  }

  // Update project upgrade_status
  await db.from('projects').update({ upgrade_status: status ?? 'pending' }).eq('id', projectId);

  return NextResponse.json({ ok: true });
}