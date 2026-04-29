import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { generatePKCE, buildAuthorizeUrl } from '@/lib/aps/auth';
import crypto from 'crypto';

export async function GET() {
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  const cookieStore = cookies();
  cookieStore.set('pkce_verifier', verifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes
  });
  cookieStore.set('pkce_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });

  const url = buildAuthorizeUrl(challenge, state);
  return NextResponse.redirect(url);
}
