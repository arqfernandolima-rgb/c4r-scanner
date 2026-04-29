export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromCookie } from '@/lib/aps/auth';
import { createServerClient } from '@/lib/supabase';
import { runPhase1Batch } from '@/lib/scan/phase1-enrich';
import { runPhase2Batch } from '@/lib/scan/phase2-files';
import { runPhase3Batch } from '@/lib/scan/phase3-versions';

export async function POST(req: NextRequest) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { jobId } = await req.json();
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

  const db = createServerClient();

  const { data: job } = await db
    .from('scan_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.status === 'completed') {
    return NextResponse.json({ done: true, phase: 'done', overall_pct: 100 });
  }
  if (job.status === 'failed' || job.status === 'paused') {
    return NextResponse.json({ done: false, phase: job.phase, status: job.status });
  }

  // Get hub settings for accountId
  const { data: settings } = await db
    .from('hub_settings')
    .select('account_id')
    .eq('hub_id', job.hub_id)
    .single();

  const accountId = settings?.account_id;

  try {
    if (job.phase === 'projects') {
      const result = await runPhase1Batch(db, jobId, accountId, token, job.phase_1_cursor);
      if (result.done) {
        await db.from('scan_jobs').update({ phase: 'files' }).eq('id', jobId);
      }
      return NextResponse.json({
        done: false,
        phase: result.done ? 'files' : 'projects',
        next_cursor: result.next_cursor,
        overall_pct: job.overall_pct,
      });
    }

    if (job.phase === 'files') {
      const result = await runPhase2Batch(db, jobId, job.hub_id, token);
      return NextResponse.json({
        done: false,
        phase: result.done ? 'versions' : 'files',
        overall_pct: job.overall_pct,
        filesFound: result.filesFound,
      });
    }

    if (job.phase === 'versions') {
      const result = await runPhase3Batch(db, jobId, token, job.phase_3_cursor);
      return NextResponse.json({
        done: result.done,
        phase: result.done ? 'done' : 'versions',
        next_cursor: result.next_cursor,
        overall_pct: result.done ? 100 : job.overall_pct,
      });
    }

    if (job.phase === 'done') {
      return NextResponse.json({ done: true, phase: 'done', overall_pct: 100 });
    }

    return NextResponse.json({ done: false, phase: job.phase, overall_pct: job.overall_pct });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Chunk processing failed';
    await db.from('scan_jobs').update({
      status: 'failed',
      error_message: message,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}