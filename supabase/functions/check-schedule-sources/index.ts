// Edge function: check-schedule-sources: the weekly court schedule check
// (supabase/migration_court_schedules.sql).
//
// Reads each approved page once, honoring robots.txt, and keeps only a hash:
// same page: its sessions stay confirmed; changed page: one row on the review
// list for a person to open. It stores no page text and publishes nothing.
//
// Called with x-push-secret by the pickleague-schedule-check cron job (Mondays).
//
// Deploy:  supabase functions deploy check-schedule-sources --no-verify-jwt
// Secrets: PUSH_SHARED_SECRET, PUSH_SECRET_MODE (shared with send-push)
// On:      private.app_config schedule_check_url = this function's URL

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireSharedSecret } from '../_kit/auth.ts';
import { normalizePageText, pageHash, robotsAllows } from '../_kit/placeScheduleWatch.ts';

const USER_AGENT = 'PickleagueScheduleCheck/1.0 (+https://pickleague.club)';
const AGENT_TOKEN = 'PickleagueScheduleCheck';
const FETCH_TIMEOUT_MS = 15_000;
/** One request every 2 seconds, so two pages on one site are never close together. */
const GAP_MS = 2_000;

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function get(url: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/** The page's hash, or the reason there isn't one. */
async function checkPage(url: string): Promise<{ status: string; hash: string | null }> {
  const u = new URL(url);
  const robots = await get(`${u.origin}/robots.txt`);
  const robotsTxt = robots.ok ? await robots.text() : '';
  // A 5xx means the site's rules are unknown: leave the page alone this week.
  if (robots.status >= 500) return { status: `robots ${robots.status}`, hash: null };
  if (!robotsAllows(robotsTxt, u.pathname + u.search, AGENT_TOKEN)) return { status: 'robots disallow', hash: null };
  await sleep(GAP_MS);
  const page = await get(url);
  if (!page.ok) return { status: `http ${page.status}`, hash: null };
  const text = normalizePageText(await page.text());
  if (text.length < 200) return { status: 'too short', hash: null };
  return { status: 'ok', hash: await pageHash(text) };
}

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
  for (const s of sources ?? []) {
    let res: { status: string; hash: string | null };
    try {
      res = await checkPage(s.url);
    } catch (e) {
      res = { status: e instanceof Error ? e.name : 'failed', hash: null };
    }
    const { data: outcome, error: saveError } = await admin.rpc('schedule_source_checked', {
      p_id: s.id,
      p_status: res.status,
      p_hash: res.hash,
    });
    const key = saveError ? 'save_failed' : String(outcome);
    counts[key] = (counts[key] ?? 0) + 1;
    console.log(`[schedule-check] ${new URL(s.url).host} ${res.status} ${key}`);
    await sleep(GAP_MS);
  }

  if ((counts.changed ?? 0) > 0) await admin.rpc('schedule_check_notify', { p_changed: counts.changed });
  return new Response(JSON.stringify({ checked: sources?.length ?? 0, ...counts }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
