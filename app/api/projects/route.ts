export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromCookie } from '@/lib/aps/auth';
import { createServerClient } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const hubId = searchParams.get('hubId');
  const jobId = searchParams.get('jobId');

  if (!hubId && !jobId) {
    return NextResponse.json({ error: 'hubId or jobId required' }, { status: 400 });
  }

  const db = createServerClient();

  let resolvedJobId = jobId;
  if (!resolvedJobId && hubId) {
    const { data: latest } = await db
      .from('scan_jobs')
      .select('id')
      .eq('hub_id', hubId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();
    resolvedJobId = latest?.id ?? null;
  }

  if (!resolvedJobId) {
    return NextResponse.json({ projects: [] });
  }

  const { data: projects } = await db
    .from('projects')
    .select('*')
    .eq('scan_job_id', resolvedJobId)
    .order('priority_score', { ascending: false });

  return NextResponse.json({ projects: projects ?? [], jobId: resolvedJobId });
}