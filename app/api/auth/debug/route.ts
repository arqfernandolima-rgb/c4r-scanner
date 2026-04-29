export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

// Temporary debug endpoint — remove before going public
export async function GET() {
  const cookieStore = cookies();
  const token = cookieStore.get('aps_token')?.value;

  const result: Record<string, unknown> = {
    has_token: !!token,
    token_length: token?.length ?? 0,
    token_preview: token ? `${token.slice(0, 20)}...` : null,
    env: {
      has_client_id: !!process.env.APS_CLIENT_ID,
      has_client_secret: !!process.env.APS_CLIENT_SECRET,
      callback_url: process.env.APS_CALLBACK_URL,
    },
  };

  if (!token) {
    return NextResponse.json({ ...result, error: 'No token cookie found' });
  }

  // Test profile/v2/userinfo
  try {
    const r1 = await fetch('https://developer.api.autodesk.com/profile/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body1 = await r1.text();
    result['profile_v2_userinfo'] = { status: r1.status, body: body1 };
  } catch (e) {
    result['profile_v2_userinfo'] = { error: String(e) };
  }

  // Test userprofile/v1/users/@me
  try {
    const r2 = await fetch('https://developer.api.autodesk.com/userprofile/v1/users/@me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body2 = await r2.text();
    result['userprofile_v1'] = { status: r2.status, body: body2 };
  } catch (e) {
    result['userprofile_v1'] = { error: String(e) };
  }

  // Test hubs
  try {
    const r3 = await fetch('https://developer.api.autodesk.com/project/v1/hubs', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body3 = await r3.text();
    result['hubs'] = { status: r3.status, body: body3.slice(0, 500) };
  } catch (e) {
    result['hubs'] = { error: String(e) };
  }

  return NextResponse.json(result, { status: 200 });
}
