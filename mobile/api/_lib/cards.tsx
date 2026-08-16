/**
 * Pickleague's link-preview cards: the data loaders and card bodies for
 * /events/:id, /leagues/:id and /tournaments/:id.
 *
 * All machinery (crawler regex, OG HTML shell, origin echo, PostgREST reader,
 * satori-safe chrome) comes from the foundation's /og subpath — this file owns
 * only what is pickleball: which tables to read and what a card says.
 *
 * The underscore directory keeps Vercel from exposing this as a route.
 * Everything reads with the anon key through existing "viewable by everyone"
 * policies, so a card can never show more than the app shows a signed-out
 * visitor. Names are first names only.
 */
import React from 'react';
// og-kit is a documented vendored copy of the foundation's /og module —
// Vercel's edge bundler refuses TypeScript inside node_modules, so the
// package subpath cannot be imported here. See og-kit.tsx's header.
import {
  createRestFetcher, firstName, clampNames,
  OgChrome, OgSimpleCard, OgBarBlock, OgStat,
  type OgPalette,
} from './og-kit';

export type CardType = 'event' | 'league' | 'tournament';

export const BRAND = 'PICKLEAGUE';
export const SITE_LABEL = 'pickleague.club';
export const FALLBACK_ORIGIN = 'https://www.pickleague.club';

/** Pickleague greens over the foundation's neutral chrome. */
export const PALETTE: OgPalette = {
  bg: '#0f1c14', panel: '#16261c', accent: '#8fe3a8', barBg: '#20342a',
  bar: '#5fae78', text: '#ffffff', muted: '#b9c7bd', faint: '#6f8476', danger: '#e07a6a',
};

const rest = createRestFetcher({
  url: process.env.EXPO_PUBLIC_SUPABASE_URL,
  key: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});

// Fixed to Pacific: the server cannot know the reader's zone, and "9:00 AM
// UTC" for a 9am Alameda game is worse than useless.
const TZ = 'America/Los_Angeles';
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleString('en-US', { ...o, timeZone: TZ });
const DAY_TIME: Intl.DateTimeFormatOptions =
  { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
/** "Sat, Aug 15 · 9:00 AM" — date and time always together. A weekday alone
 *  ("Fri") is ambiguous the moment a link outlives the week it was shared. */
const dayDotTime = (iso: string) =>
  `${fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmt(iso, { hour: 'numeric', minute: '2-digit' })}`;

export type Card = { title: string; description: string; body: React.ReactElement };

const simple = (title: string, sub: string): Card => ({
  title,
  description: sub,
  body: <OgSimpleCard brand={BRAND} site={SITE_LABEL} title={title} sub={sub} colors={PALETTE} />,
});

export const GENERIC_CARD: Card = simple('Pickleague', 'Pick a time, play some pickleball.');

export async function loadCard(type: CardType, id: string): Promise<Card | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (type === 'event') return eventCard(id);
  if (type === 'league') return leagueCard(id);
  return tournamentCard(id);
}

// ── Event ─────────────────────────────────────────────────────

async function eventCard(id: string): Promise<Card | null> {
  const eid = encodeURIComponent(id);
  const ev = (await rest(
    `league_events?id=eq.${eid}&select=id,title,status,vote_ends_at,confirmed_slot_id,min_players,league_id&limit=1`,
  ))[0];
  if (!ev) return null;

  const slotRows = await rest(`event_slots?event_id=eq.${eid}&select=id,starts_at&order=starts_at`);
  const [votes, declines, members] = await Promise.all([
    slotRows.length
      ? rest(`event_slot_votes?slot_id=in.(${slotRows.map((s: any) => s.id).join(',')})`
          + `&select=slot_id,user_id,profile:profiles(full_name)`)
      : Promise.resolve([]),
    rest(`event_declines?event_id=eq.${eid}&select=user_id,profile:profiles(full_name)`),
    rest(`league_members?league_id=eq.${encodeURIComponent(ev.league_id)}`
        + `&select=user_id,profile:profiles(full_name,deleted_at)`),
  ]);

  const perSlot = new Map<string, string[]>();
  for (const v of votes) {
    perSlot.set(v.slot_id, [...(perSlot.get(v.slot_id) ?? []), firstName(v.profile?.full_name)]);
  }
  const voterIds = new Set(votes.map((v: any) => v.user_id));
  const declinerIds = new Set(declines.map((d: any) => d.user_id));
  const decliners = declines.map((d: any) => firstName(d.profile?.full_name));
  const slots = slotRows.map((s: any) => ({ ...s, voters: perSlot.get(s.id) ?? [] }));
  // Empty membership is indistinguishable from unreadable — only claim
  // knowledge of who has not replied when rows actually came back.
  const nonResponders: string[] | null = members.length
    ? members
        .filter((m: any) => !voterIds.has(m.user_id) && !declinerIds.has(m.user_id) && !m.profile?.deleted_at)
        .map((m: any) => firstName(m.profile?.full_name))
    : null;

  if (ev.status === 'cancelled') {
    return simple(`${ev.title} — cancelled`, 'Not enough players could agree on a time.');
  }

  if (ev.status === 'scheduled') {
    const slot = slots.find((s: any) => s.id === ev.confirmed_slot_id);
    const when = slot
      ? fmt(slot.starts_at, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'Time confirmed';
    const going: string[] = slot?.voters ?? [];
    return {
      title: `${ev.title} — it's on`,
      description: `${when} · ${going.length} ${going.length === 1 ? 'player' : 'players'} in. Tap for details.`,
      body: (
        <OgChrome brand={BRAND} site={SITE_LABEL} colors={PALETTE}>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1 }}>
            <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, color: PALETTE.accent, letterSpacing: 1 }}>
              IT'S ON
            </div>
            <div style={{ display: 'flex', fontSize: ev.title.length > 26 ? 48 : 62, fontWeight: 800, color: PALETTE.text, marginTop: 10 }}>
              {ev.title}
            </div>
            <div style={{ display: 'flex', fontSize: 40, color: PALETTE.text, marginTop: 22 }}>{when}</div>
            <div style={{ display: 'flex', fontSize: 27, color: PALETTE.muted, marginTop: 18 }}>
              {going.length ? `Playing (${going.length}): ${clampNames(going, 8)}` : 'Tap for the roster'}
            </div>
            {decliners.length > 0 && (
              <div style={{ display: 'flex', fontSize: 23, color: PALETTE.danger, marginTop: 10 }}>
                Out: {clampNames(decliners, 6)}
              </div>
            )}
          </div>
        </OgChrome>
      ),
    };
  }

  // Voting open — the snapshot tally is the whole point of the card.
  const most = Math.max(1, ...slots.map((s: any) => s.voters.length));
  const closed = new Date(ev.vote_ends_at) <= new Date();
  const leader = [...slots].sort(
    (a: any, b: any) => b.voters.length - a.voters.length
      || new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
  )[0];

  const parts = [`${voterIds.size} ${voterIds.size === 1 ? 'person has' : 'people have'} voted`];
  if (leader && leader.voters.length > 0) {
    parts.push(`${dayDotTime(leader.starts_at)} leading (${leader.voters.length})`);
  }
  if (ev.min_players != null) parts.push(`needs ${ev.min_players} on one time`);
  parts.push(closed ? 'voting closed' : `closes ${dayDotTime(ev.vote_ends_at)}`);
  if (nonResponders?.length) parts.push(`waiting on ${clampNames(nonResponders, 4)}`);

  // The header carries the deadline and the threshold; the footer carries the
  // people. More than 4 slots shrinks the header a little to keep 630px.
  const many = slots.length > 4;

  return {
    title: `Vote: ${ev.title}`,
    description: parts.join(' · '),
    body: (
      <OgChrome brand={BRAND} site={SITE_LABEL} colors={PALETTE}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: many ? 8 : 16 }}>
          <div style={{ display: 'flex', fontSize: ev.title.length > 26 ? 36 : many ? 40 : 48, fontWeight: 800, color: PALETTE.text }}>
            {ev.title}
          </div>
          <div style={{ display: 'flex', fontSize: 24, color: PALETTE.muted }}>
            {closed ? 'voting closed' : `voting closes ${dayDotTime(ev.vote_ends_at)}`}
            {ev.min_players != null ? ` · needs ${ev.min_players} on one time` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: many ? 12 : 18, flexGrow: 1 }}>
          {slots.slice(0, 6).map((s: any) => {
            const n = s.voters.length;
            const hit = ev.min_players != null && n >= ev.min_players;
            return (
              <OgBarBlock
                key={s.id}
                label={dayDotTime(s.starts_at)}
                caption={n === 0 ? 'no votes yet'
                  : `${n} ${n === 1 ? 'vote' : 'votes'}${hit ? ' — enough to play' : ''} · ${clampNames(s.voters, 5)}`}
                frac={n / most}
                emphasized={hit}
                empty={n === 0}
                colors={PALETTE}
              />
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
          <div style={{ display: 'flex', fontSize: 22, color: decliners.length ? PALETTE.danger : PALETTE.faint }}>
            {decliners.length ? `Can't make it: ${clampNames(decliners, 5)}` : ''}
          </div>
          <div style={{ display: 'flex', fontSize: 22, color: PALETTE.faint }}>
            {nonResponders === null ? ''
              : nonResponders.length ? `Waiting on: ${clampNames(nonResponders, 6)}`
              : 'Everyone has replied'}
          </div>
        </div>
      </OgChrome>
    ),
  };
}

// ── League ────────────────────────────────────────────────────

async function leagueCard(id: string): Promise<Card | null> {
  const lid = encodeURIComponent(id);
  const lg = (await rest(`leagues?id=eq.${lid}&select=id,name,description&limit=1`))[0];
  if (!lg) return null;

  const members = await rest(
    `league_members?league_id=eq.${lid}&select=user_id,profile:profiles(full_name,rating,total_matches_played,deleted_at)`,
  );
  const active = members.filter((m: any) => m.profile && !m.profile.deleted_at);
  const top = [...active]
    .sort((a: any, b: any) => (b.profile.rating ?? 0) - (a.profile.rating ?? 0))
    .slice(0, 4);
  const matches = active.reduce((n: number, m: any) => n + (m.profile.total_matches_played ?? 0), 0);

  const description = `${active.length} ${active.length === 1 ? 'player' : 'players'}`
    + (matches ? ` · ${matches} matches played` : '')
    + '. Tap to join or see standings.';

  return {
    title: lg.name,
    description,
    body: (
      <OgChrome brand={BRAND} site={SITE_LABEL} colors={PALETTE}>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }}>
          <div style={{ display: 'flex', fontSize: lg.name.length > 26 ? 44 : 56, fontWeight: 800, color: PALETTE.text }}>
            {lg.name}
          </div>
          {lg.description ? (
            <div style={{ display: 'flex', fontSize: 25, color: PALETTE.muted, marginTop: 12 }}>
              {String(lg.description).slice(0, 90)}
            </div>
          ) : null}
          <div style={{ display: 'flex', marginTop: 34 }}>
            <OgStat label="PLAYERS" value={String(active.length)} colors={PALETTE} />
            {matches > 0 && <OgStat label="MATCHES" value={String(matches)} colors={PALETTE} />}
          </div>
          {top.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 30 }}>
              <div style={{ display: 'flex', fontSize: 20, color: PALETTE.faint, letterSpacing: 1 }}>TOP PLAYERS</div>
              <div style={{ display: 'flex', marginTop: 8 }}>
                {top.map((m: any) => (
                  <div key={m.user_id} style={{
                    display: 'flex', backgroundColor: PALETTE.panel, borderRadius: 12,
                    padding: '10px 18px', marginRight: 12, fontSize: 24, color: PALETTE.text,
                  }}>
                    {firstName(m.profile.full_name)}
                    <div style={{ display: 'flex', color: PALETTE.accent, marginLeft: 10, fontWeight: 700 }}>
                      {Number(m.profile.rating ?? 0).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </OgChrome>
    ),
  };
}

// ── Tournament ────────────────────────────────────────────────

const FORMAT_LABEL: Record<string, string> = {
  round_robin: 'Round robin', single_elim: 'Single elim', double_elim: 'Double elim',
  pool_play: 'Pool play', mlp: 'MLP',
};

async function tournamentCard(id: string): Promise<Card | null> {
  const tid = encodeURIComponent(id);
  const t = (await rest(
    `tournaments?id=eq.${tid}`
    + `&select=id,name,status,format,match_type,start_time,location_name,max_players,registration_closes_at&limit=1`,
  ))[0];
  if (!t) return null;

  const regs = await rest(
    `tournament_registrations?tournament_id=eq.${tid}&status=eq.approved`
    + `&select=user_id,profile:profiles(full_name,deleted_at)`,
  );
  const players = regs
    .filter((r: any) => r.profile && !r.profile.deleted_at)
    .map((r: any) => firstName(r.profile.full_name));

  const format = FORMAT_LABEL[t.format] ?? t.format ?? '—';
  const matchType = t.match_type ? String(t.match_type)[0].toUpperCase() + String(t.match_type).slice(1) : '—';
  const when = t.start_time ? fmt(t.start_time, DAY_TIME) : 'TBD';

  const statusLine =
    t.status === 'registration'
      ? `Registration open — ${players.length}${t.max_players ? ` of ${t.max_players}` : ''} in`
      : t.status === 'active' ? 'In progress'
      : t.status === 'completed' ? 'Finished'
      : t.status === 'cancelled' ? 'Cancelled' : t.status;

  return {
    title: t.status === 'registration' ? `${t.name} — registration open` : t.name,
    description: `${statusLine} · ${format} ${matchType.toLowerCase()} · ${when}`
      + (t.location_name ? ` · ${t.location_name}` : ''),
    body: (
      <OgChrome brand={BRAND} site={SITE_LABEL} colors={PALETTE}>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }}>
          <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, color: PALETTE.accent, letterSpacing: 1 }}>
            {statusLine.toUpperCase()}
          </div>
          <div style={{ display: 'flex', fontSize: t.name.length > 26 ? 44 : 56, fontWeight: 800, color: PALETTE.text, marginTop: 10 }}>
            {t.name}
          </div>
          <div style={{ display: 'flex', marginTop: 30 }}>
            <OgStat label="WHEN" value={when} colors={PALETTE} />
            <OgStat label="FORMAT" value={`${format} · ${matchType}`} colors={PALETTE} />
            {t.location_name ? <OgStat label="WHERE" value={String(t.location_name).slice(0, 24)} colors={PALETTE} /> : null}
          </div>
          <div style={{ display: 'flex', fontSize: 25, color: PALETTE.muted, marginTop: 28 }}>
            {players.length
              ? `Playing (${players.length}${t.max_players ? `/${t.max_players}` : ''}): ${clampNames(players, 7)}`
              : t.status === 'registration' ? 'No one has registered yet — be first.' : ''}
          </div>
        </div>
      </OgChrome>
    ),
  };
}
