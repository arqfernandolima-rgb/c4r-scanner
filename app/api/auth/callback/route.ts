import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { exchangeCodeForToken } from '@/lib/aps/auth';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(error)}`, req.url));
  }

  const cookieStore = cookies();
  const savedState = cookieStore.get('pkce_state')?.value;
  const verifier = cookieStore.get('pkce_verifier')?.value;

  if (!code || !state || state !== savedState || !verifier) {
    return NextResponse.redirect(new URL('/?error=invalid_state', req.url));
  }

  try {
    const tokenData = await exchangeCodeForToken(code, verifier);

    cookieStore.set('aps_token', tokenData.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: tokenData.expires_in,
    });

    // Clear PKCE cookies
    cookieStore.delete('pkce_verifier');
    cookieStore.delete('pkce_state');

    return NextResponse.redirect(new URL('/dashboard', req.url));
  } catch {
    return NextResponse.redirect(new URL('/?error=token_exchange_failed', req.url));
  }
}
