import { cookies } from 'next/headers';
import crypto from 'crypto';

const APS_AUTH_URL = 'https://developer.api.autodesk.com/authentication/v2';

export function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.APS_CLIENT_ID!,
    redirect_uri: process.env.APS_CALLBACK_URL!,
    scope: 'data:read account:read',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${APS_AUTH_URL}/authorize?${params}`;
}

export async function exchangeCodeForToken(code: string, verifier: string): Promise<{
  access_token: string;
  expires_in: number;
  token_type: string;
}> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: process.env.APS_CLIENT_ID!,
    client_secret: process.env.APS_CLIENT_SECRET!,
    code_verifier: verifier,
    redirect_uri: process.env.APS_CALLBACK_URL!,
  });

  const res = await fetch(`${APS_AUTH_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }
  return res.json();
}

export async function getTokenFromCookie(): Promise<string | null> {
  const cookieStore = cookies();
  return cookieStore.get('aps_token')?.value ?? null;
}

export async function getUserInfo(token: string): Promise<{
  name: string;
  email: string;
  userId: string;
}> {
  const res = await fetch('https://developer.api.autodesk.com/userprofile/v1/users/@me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch user info');
  const data = await res.json();
  return {
    name: `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim(),
    email: data.emailId ?? '',
    userId: data.userId ?? '',
  };
}
