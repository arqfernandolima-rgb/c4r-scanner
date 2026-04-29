export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromCookie } from '@/lib/aps/auth';
import { createServerClient } from '@/lib/supabase';
import { runPhase0 } from '@/lib/scan/phase0-bootstrap';

export async function POST(req: NextRequest) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { hubId, accountId } = await req.json();
  if (!hubId || !accountId) {
    return NextResponse.json({ error: 'hubId and accountId are required' }, { status: 400 });
  }

  const db = createServerClient();

  // Check for stale running scan (updated_at > 90s ago → auto-resume)
  const { data: existing } = await db
    .from('scan_jobs')
    .select('id, status, updated_at')
    .eq('hub_id', hubId)
    .eq('status', 'running')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (existing) {
    const staleSince = Date.now() - new Date(existing.updated_at).getTime();
    if (staleSince < 90_000) {
      return NextResponse.json({ jobId: existing.id, status: 'already_running' });
    }
    // Stale — mark failed and start fresh
    await db.from('scan_jobs').update({ status: 'failed' }).eq('id', existing.id);
  }

  // Ensure hub_settings row exists
  await db.from('hub_settings').upsert({
    hub_id: hubId,
    account_id: accountId,
    deprecated_below_version: process.env.NEXT_PUBLIC_DEPRECATED_BELOW_VERSION ?? '2022',
    deadline_date: process.env.NEXT_PUBLIC_DEADLINE_DATE ?? null,
  }, { onConflict: 'hub_id' });

  // Create scan job
  const { data: job, error } = await db
    .from('scan_jobs')
    .insert({
      hub_id: hubId,
      status: 'running',
      phase: 'bootstrap',
      triggered_by: 'manual',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !job) {
    return NextResponse.json({ error: 'Failed to create scan job' }, { status: 500 });
  }

  try {
    const totalProjects = await runPhase0(db, job.id, hubId, accountId, token);
    return NextResponse.json({ jobId: job.id, status: 'started', total_projects: totalProjects });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Phase 0 failed';
    await db.from('scan_jobs').update({
      status: 'failed',
      error_message: message,
    }).eq('id', job.id);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}