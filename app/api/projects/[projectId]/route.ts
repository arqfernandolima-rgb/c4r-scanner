export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromCookie } from '@/lib/aps/auth';
import { createServerClient } from '@/lib/supabase';

export async function GET(
  _req: NextRequest,
  { params }: { params: { projectId: string } }
) {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServerClient();

  const { data: project } = await db
    .from('projects')
    .select('*')
    .eq('id', params.projectId)
    .single();

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: files } = await db
    .from('revit_files')
    .select('*')
    .eq('project_id', params.projectId)
    .order('needs_upgrade', { ascending: false })
    .order('revit_version', { ascending: true });

  return NextResponse.json({ project, files: files ?? [] });
}