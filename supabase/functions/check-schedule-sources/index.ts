// Edge function: check-schedule-sources: the weekly court schedule check
// (supabase/migration_court_schedules.sql).
//
// Reads each approved page once, honoring robots.txt, and keeps only a hash
// (the kit's sourceWatch, vendored in ../_kit): same page: its sessions stay
// confirmed; changed page: one row on the review list for a person to open. It
// stores no page text and publishes nothing.
//
// Called with x-push-secret by the pickleague-schedule-check cron job (Mondays).
//
// Deploy:  supabase functions deploy check-schedule-sources --no-verify-jwt
// Secrets: PUSH_SHARED_SECRET, PUSH_SECRET_MODE (shared with send-push)
// On:      private.app_config schedule_check_url = this function's URL

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireSharedSecret } from '../_kit/auth.ts';
import { checkPages } from '../_kit/sourceWatch.mjs';

const WATCH = {
  userAgent: 'PickleagueScheduleCheck/1.0 (+https://pickleague.club)',
  token: 'PickleagueScheduleCheck',
};

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req) => {
  const denied = await requireSharedSecret(req, { label: 'schedule-check' });
  if (denied) return denied;

  const { data: sources, error } = await admin
    .from('court_schedule_sources')
    .select('id, url')
    .eq('method', 'fetch')
    .eq('active', true)
    .not('terms_checked_at', 'is', null);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const counts: Record<string, number> = {};
  await checkPages(sources ?? [], WATCH, async (s, res) => {
    const { data: outcome, error: saveError } = await admin.rpc('schedule_source_checked', {
      p_id: s.id,
      p_status: res.status,
      p_hash: res.hash,
    });
    const key = saveError ? 'save_failed' : String(outcome);
    counts[key] = (counts[key] ?? 0) + 1;
    console.log(`[schedule-check] ${new URL(s.url).host} ${res.status} ${key}`);
  });

  if ((counts.changed ?? 0) > 0) await admin.rpc('schedule_check_notify', { p_changed: counts.changed });
  return new Response(JSON.stringify({ checked: sources?.length ?? 0, ...counts }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
