export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getTokenFromCookie } from '@/lib/aps/auth';
import { listHubs } from '@/lib/aps/dm';

export async function GET() {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const hubs = await listHubs(token);
    return NextResponse.json({ hubs });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch hubs' }, { status: 500 });
  }
}