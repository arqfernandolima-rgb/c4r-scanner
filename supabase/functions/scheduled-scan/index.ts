// Supabase Edge Function — triggered by pg_cron weekly
// Calls the Next.js /api/scan/start for each hub that has a completed scan
// Requires: APP_URL and SERVICE_ROLE_KEY set in Supabase Edge Function env

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const appUrl = Deno.env.get('APP_URL')!;
const appServiceKey = Deno.env.get('APP_SERVICE_KEY')!; // shared secret for internal calls

Deno.serve(async (_req: Request) => {
  const db = createClient(supabaseUrl, serviceRoleKey);

  // Find all hub_settings rows
  const { data: hubs } = await db.from('hub_settings').select('hub_id, account_id');
  if (!hubs || hubs.length === 0) {
    return new Response(JSON.stringify({ message: 'No hubs configured' }), { status: 200 });
  }

  const results = [];
  for (const hub of hubs) {
    // Check if a scan is already running
    const { data: running } = await db
      .from('scan_jobs')
      .select('id')
      .eq('hub_id', hub.hub_id)
      .eq('status', 'running')
      .limit(1)
      .single();

    if (running) {
      results.push({ hubId: hub.hub_id, skipped: true, reason: 'scan already running' });
      continue;
    }

    // Trigger scan via internal API call
    const res = await fetch(`${appUrl}/api/scan/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': appServiceKey,
      },
      body: JSON.stringify({ hubId: hub.hub_id, accountId: hub.account_id, triggeredBy: 'scheduled' }),
    });

    results.push({ hubId: hub.hub_id, status: res.status });
  }

  return new Response(JSON.stringify({ triggered: results }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
});
