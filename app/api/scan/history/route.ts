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
    .select('id, completed_at, total_rvt_files, at_risk_count')
    .eq('hub_id', hubId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(8);

  if (!jobs || jobs.length === 0) return NextResponse.json({ jobs: [], trendData: [] });

  const sorted = [...jobs].reverse();
  const firstAtRisk = sorted[0]?.at_risk_count ?? 0;
  const trendData = sorted.map((j) => {
    const label = new Date(j.completed_at!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const atRisk = j.at_risk_count ?? 0;
    const cleared = Math.max(0, firstAtRisk - atRisk);
    return { label, atRisk, cleared };
  });

  return NextResponse.json({ jobs, trendData });
}