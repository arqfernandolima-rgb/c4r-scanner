export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromCookie } from '@/lib/aps/auth';
import { createServerClient } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const hubId = searchParams.get('hubId');
  if (!hubId) return NextResponse.json({ jobs: [], trendData: [] });

  const db = createServerClient();
  const { data: jobs } = await db
    .from('scan_jobs')
    .select('id, status, started_at, completed_at, total_projects, total_rvt_files, at_risk_count, error_message, created_at')
    .eq('hub_id', hubId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (!jobs || jobs.length === 0) return NextResponse.json({ jobs: [], trendData: [] });

  // Build trend from completed jobs only (oldest→newest)
  const completed = jobs.filter(j => j.status === 'completed' && j.completed_at).reverse();
  const firstAtRisk = completed[0]?.at_risk_count ?? 0;
  const trendData = completed.map(j => ({
    label: new Date(j.completed_at!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    atRisk: j.at_risk_count ?? 0,
    cleared: Math.max(0, firstAtRisk - (j.at_risk_count ?? 0)),
  }));

  return NextResponse.json({ jobs, trendData });
}
