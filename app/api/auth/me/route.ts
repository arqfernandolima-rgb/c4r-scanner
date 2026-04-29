export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getTokenFromCookie, getUserInfo } from '@/lib/aps/auth';

export async function GET() {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const user = await getUserInfo(token);
    return NextResponse.json(user);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch user info' }, { status: 500 });
  }
}