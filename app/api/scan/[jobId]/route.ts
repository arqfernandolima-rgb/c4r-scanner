export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromCookie } from '@/lib/aps/auth';
import { createServerClient } from '@/lib/supabase';

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServerClient();
  const { data: job } = await db
    .from('scan_jobs')
    .select('*')
    .eq('id', params.jobId)
    .single();

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(job);
}

export async function PATCH(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServerClient();
  await db.from('scan_jobs').update({ status: 'paused' }).eq('id', params.jobId);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServerClient();

  // Guard: don't delete a scan that is actively running
  const { data: job } = await db
    .from('scan_jobs')
    .select('status')
    .eq('id', params.jobId)
    .single();

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (job.status === 'running') {
    return NextResponse.json({ error: 'Cannot delete a running scan. Pause it first.' }, { status: 409 });
  }

  // Cascade deletes projects → revit_files via FK constraints
  const { error } = await db.from('scan_jobs').delete().eq('id', params.jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
