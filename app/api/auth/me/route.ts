export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getTokenFromCookie, getUserInfo } from '@/lib/aps/auth';

export async function GET() {
  const token = await getTokenFromCookie();
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const user = await getUserInfo(token);
    return NextResponse.json(user);
  } catch (err: unknown) {
    console.error('[auth/me] getUserInfo error:', err);
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: String(err), status }, { status: 500 });
  }
}