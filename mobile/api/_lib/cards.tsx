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

export type CardType = 'event' | 'league' | 'tournament' | 'season';

export function parseCardType(raw: string | null): CardType {
  return raw === 'league' || raw === 'tournament' || raw === 'season' ? raw : 'event';
}

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
/** Date-ONLY strings ('2026-05-01') must not go through the TZ formatter —
 *  they parse as UTC midnight, which is the previous day in Pacific. */
const fmtDateOnly = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const dayDotTime = (iso: string) =>
  `${fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmt(iso, { hour: 'numeric', minute: '2-digit' })}`;

export type Card = {
  title: string;
  description: string;
  body: React.ReactElement;
  /** Everything the IMAGE renders that the description may not mention (e.g.
   *  decliners in a fully-replied league). og.ts hashes this into the image
   *  URL so any visual change forces chat proxies to refetch the picture. */
  fingerprint?: string;
};

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
  if (type === 'season') return seasonCard(id);
  return tournamentCard(id);
}

// ── Event ─────────────────────────────────────────────────────

async function eventCard(id: string): Promise<Card | null> {
  const eid = encodeURIComponent(id);
  const ev = (await rest(
    `league_events?id=eq.${eid}&select=id,title,status,vote_ends_at,confirmed_slot_id,min_players,league_id,location_name&limit=1`,
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
  const nameOf = new Map<string, string>();
  for (const v of votes) {
    nameOf.set(v.user_id, firstName(v.profile?.full_name));
    perSlot.set(v.slot_id, [...(perSlot.get(v.slot_id) ?? []), firstName(v.profile?.full_name)]);
  }
  const voterIds = new Set(votes.map((v: any) => v.user_id));
  // One name per distinct person, however many slots they marked.
  const votedNames = [...voterIds].map((id) => nameOf.get(id as string) ?? '?');
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
      description: `${when}${ev.location_name ? ` at ${ev.location_name}` : ''}`
        + ` · ${going.length} ${going.length === 1 ? 'player' : 'players'} in. Tap for details.`,
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
            {ev.location_name ? (
              <div style={{ display: 'flex', fontSize: 28, color: PALETTE.accent, marginTop: 10 }}>
                {`at ${ev.location_name}`}
              </div>
            ) : null}
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

  const parts = [
    votedNames.length ? `Voted: ${clampNames(votedNames, 4)}` : 'No votes yet',
  ];
  if (ev.location_name) parts.push(`at ${ev.location_name}`);
  if (leader && leader.voters.length > 0) {
    parts.push(`${dayDotTime(leader.starts_at)} leading (${leader.voters.length})`);
  }
  if (ev.min_players != null) parts.push(`needs ${ev.min_players} on one time`);
  parts.push(closed ? 'voting closed' : `closes ${dayDotTime(ev.vote_ends_at)}`);
  if (nonResponders?.length) parts.push(`waiting on ${clampNames(nonResponders, 4)}`);

  // The header carries the deadline and threshold; the roll-call under the
  // bars carries the people. 5+ slots switches to compact bars and a one-line
  // roll-call — satori clips at the canvas edge, so overflow loses rows.
  const many = slots.length > 4;

  return {
    title: `Vote: ${ev.title}`,
    description: parts.join(' · '),
    fingerprint: JSON.stringify({
      s: slots.map((s: any) => s.voters),
      d: decliners,
      w: nonResponders,
      e: ev.vote_ends_at,
      m: ev.min_players,
    }),
    body: (
      <OgChrome brand={BRAND} site={SITE_LABEL} colors={PALETTE}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: many ? 8 : 16 }}>
          <div style={{ display: 'flex', fontSize: ev.title.length > 26 ? 36 : many ? 40 : 48, fontWeight: 800, color: PALETTE.text }}>
            {ev.title}
          </div>
          <div style={{ display: 'flex', fontSize: 24, color: PALETTE.muted }}>
            {ev.location_name ? `at ${ev.location_name} · ` : ''}
            {closed ? 'voting closed' : `voting closes ${dayDotTime(ev.vote_ends_at)}`}
            {ev.min_players != null ? ` · needs ${ev.min_players} on one time` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: many ? 10 : 18, flexGrow: 1 }}>
          {slots.slice(0, 6).map((s: any) => {
            const n = s.voters.length;
            const hit = ev.min_players != null && n >= ev.min_players;
            return (
              <OgBarBlock
                key={s.id}
                label={dayDotTime(s.starts_at)}
                caption={n === 0 ? 'no votes yet'
                  : `${n} ${n === 1 ? 'vote' : 'votes'}${hit ? ' — enough to play' : ''} · ${clampNames(s.voters, many ? 3 : 5)}`}
                frac={n / most}
                emphasized={hit}
                empty={n === 0}
                compact={many}
                colors={PALETTE}
              />
            );
          })}
        </div>

        {/* Roll-call: who is in, who is out, who has not answered. */}
        {many ? (
          <div style={{ display: 'flex', fontSize: 20, color: PALETTE.muted, marginTop: 2 }}>
            {[
              nonResponders === null ? '' : nonResponders.length
                ? `Waiting on: ${clampNames(nonResponders, 5)}` : 'Everyone has replied',
              decliners.length ? `Out: ${clampNames(decliners, 4)}` : '',
            ].filter(Boolean).join('   ·   ')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 2 }}>
            <div style={{ display: 'flex', fontSize: 22, color: PALETTE.text }}>
              {votedNames.length
                ? `Voted (${votedNames.length}): ${clampNames(votedNames, 7)}`
                : 'Nobody has voted yet'}
            </div>
            {nonResponders !== null && (
              <div style={{ display: 'flex', fontSize: 22, color: PALETTE.faint, marginTop: 6 }}>
                {nonResponders.length
                  ? `Waiting on (${nonResponders.length}): ${clampNames(nonResponders, 7)}`
                  : 'Everyone has replied'}
              </div>
            )}
            {decliners.length > 0 && (
              <div style={{ display: 'flex', fontSize: 22, color: PALETTE.danger, marginTop: 6 }}>
                {`Can't make it (${decliners.length}): ${clampNames(decliners, 6)}`}
              </div>
            )}
          </div>
        )}
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

// ── Season ────────────────────────────────────────────────────

async function seasonCard(id: string): Promise<Card | null> {
  const sid = encodeURIComponent(id);
  const s = (await rest(
    `league_seasons?id=eq.${sid}`
    + `&select=id,name,league_id,status,start_date,end_date,total_periods,lock_frequency_weeks,prize_pool&limit=1`,
  ))[0];
  if (!s) return null;

  const [league, podium, snapshots] = await Promise.all([
    rest(`leagues?id=eq.${encodeURIComponent(s.league_id)}&select=name&limit=1`).then(r => r[0]),
    // Final standings exist only once the season completes; empty until then.
    rest(`season_final_standings?season_id=eq.${sid}&order=final_rank.asc&limit=3`
      + `&select=final_rank,user_id,profile:profiles(full_name)`),
    // One row per player per LOCKED period; nothing for the period underway.
    rest(`season_snapshots?season_id=eq.${sid}`
      + `&select=period_number,rank_at_snapshot,wins_in_season,losses_in_season,user_id,profile:profiles(full_name)`
      + `&order=period_number.asc,rank_at_snapshot.asc`),
  ]);

  const dates = s.start_date && s.end_date
    ? `${fmtDateOnly(s.start_date)} – ${fmtDateOnly(s.end_date)}`
    : '';
  const complete = s.status === 'completed' || podium.length > 0;

  // Current period from the calendar (mirrors SeasonStandingsScreen's math):
  // period N covers [start + (N-1)·freq weeks, start + N·freq weeks).
  let currentPeriod: number | null = null;
  if (!complete && s.start_date && s.lock_frequency_weeks) {
    const [y, m, d] = String(s.start_date).split('-').map(Number);
    const elapsedDays = Math.floor((Date.now() - new Date(y, m - 1, d).getTime()) / 86_400_000);
    currentPeriod = Math.min(
      s.total_periods ?? 99,
      Math.max(1, Math.floor(elapsedDays / (s.lock_frequency_weeks * 7)) + 1),
    );
  }

  // Each period's rank 1 is that period's winner; the LAST locked period's
  // rows are the current standings ("after period N").
  const periodWinners: { period: number; name: string }[] = [];
  let lastLocked = 0;
  for (const row of snapshots) {
    if (row.period_number > lastLocked) lastLocked = row.period_number;
    if (row.rank_at_snapshot === 1) {
      periodWinners.push({ period: row.period_number, name: firstName(row.profile?.full_name) });
    }
  }
  const standings = snapshots
    .filter((r: any) => r.period_number === lastLocked)
    .slice(0, 3)
    .map((r: any) => ({
      name: firstName(r.profile?.full_name),
      record: `${r.wins_in_season}-${r.losses_in_season}`,
    }));

  const statusLine = complete
    ? 'Season complete'
    : currentPeriod
      ? `Season underway — period ${currentPeriod}${s.total_periods ? ` of ${s.total_periods}` : ''}`
      : 'Season underway';
  const podiumNames = podium.map((p: any) => firstName(p.profile?.full_name));

  const descBits = [statusLine];
  if (dates) descBits.push(dates);
  if (complete && podiumNames.length) descBits.push(`Champion: ${podiumNames[0]}`);
  if (!complete && standings.length) {
    descBits.push(`Leading after period ${lastLocked}: ${standings.map(x => `${x.name} (${x.record})`).slice(0, 2).join(', ')}`);
  }
  if (s.prize_pool) descBits.push(`${s.prize_pool} pickle prize pool`);

  // Completed seasons put the podium in the strip; active ones the standings.
  const strip = complete
    ? podiumNames.map((n: string, i: number) => ({ label: `${i + 1}. ${n}`, sub: '' }))
    : standings.map((x, i) => ({ label: `${i + 1}. ${x.name}`, sub: x.record }));
  const stripTitle = complete ? 'PODIUM' : lastLocked ? `STANDINGS AFTER PERIOD ${lastLocked}` : '';

  return {
    title: `${league?.name ?? 'League'} — ${s.name}`,
    description: descBits.join(' · ') + '. Tap for the standings.',
    fingerprint: JSON.stringify({ st: s.status, p: currentPeriod, w: periodWinners, s: standings, f: podiumNames }),
    body: (
      <OgChrome brand={BRAND} site={SITE_LABEL} colors={PALETTE}>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }}>
          <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, color: PALETTE.accent, letterSpacing: 1 }}>
            {statusLine.toUpperCase()}
          </div>
          <div style={{ display: 'flex', fontSize: 44, fontWeight: 800, color: PALETTE.text, marginTop: 8 }}>
            {`${league?.name ?? 'League'} — ${s.name}`}
          </div>
          <div style={{ display: 'flex', marginTop: 22 }}>
            {dates ? <OgStat label="DATES" value={dates} colors={PALETTE} /> : null}
            {s.prize_pool ? <OgStat label="PRIZE POOL" value={`${s.prize_pool} pickles`} colors={PALETTE} /> : null}
          </div>

          {strip.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 22 }}>
              <div style={{ display: 'flex', fontSize: 20, color: PALETTE.faint, letterSpacing: 1 }}>{stripTitle}</div>
              <div style={{ display: 'flex', marginTop: 8 }}>
                {strip.map((x, i) => (
                  <div key={x.label} style={{
                    display: 'flex', backgroundColor: PALETTE.panel, borderRadius: 12,
                    padding: '10px 18px', marginRight: 12, fontSize: 24,
                    color: i === 0 ? PALETTE.accent : PALETTE.text, fontWeight: i === 0 ? 800 : 400,
                  }}>
                    {x.label}
                    {x.sub ? (
                      <div style={{ display: 'flex', marginLeft: 10, fontWeight: 700, color: PALETTE.muted }}>{x.sub}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}

          {periodWinners.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 20 }}>
              <div style={{ display: 'flex', fontSize: 20, color: PALETTE.faint, letterSpacing: 1 }}>PERIOD WINNERS</div>
              <div style={{ display: 'flex', marginTop: 8 }}>
                {periodWinners.slice(-6).map((w) => (
                  <div key={w.period} style={{
                    display: 'flex', backgroundColor: PALETTE.panel, borderRadius: 10,
                    padding: '7px 14px', marginRight: 10, fontSize: 20, color: PALETTE.muted,
                  }}>
                    {`P${w.period}`}
                    <div style={{ display: 'flex', marginLeft: 8, color: PALETTE.text, fontWeight: 700 }}>{w.name}</div>
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

  const [regs, matches, teams] = await Promise.all([
    // The embed MUST name its FK: tournament_registrations has two FKs to
    // profiles (user_id, invited_by), and an ambiguous embed is a PostgREST
    // error that our fetcher surfaces as [] — the roster silently vanished
    // from the first version of this card.
    rest(`tournament_registrations?tournament_id=eq.${tid}&status=eq.approved`
      + `&select=user_id,profile:profiles!tournament_registrations_user_id_fkey(full_name,deleted_at)`),
    rest(`tournament_matches?tournament_id=eq.${tid}`
      + `&select=team1_player1,team1_player2,team2_player1,team2_player2,winner_team`),
    rest(`mlp_teams?tournament_id=eq.${tid}&select=id,name,captain_id,male_1_id,male_2_id,female_1_id,female_2_id`),
  ]);

  const nameById = new Map<string, string>();
  const players: string[] = [];
  for (const r of regs) {
    if (!r.profile || r.profile.deleted_at) continue;
    nameById.set(r.user_id, firstName(r.profile.full_name));
    players.push(firstName(r.profile.full_name));
  }

  // ── Standings, computed from the matches themselves ────────────
  // tournament_matches carries only player slots, so team standings come from
  // mapping winners back onto MLP rosters; without teams it is a player
  // leaderboard. Same computation serves 'active' (live) and 'completed'.
  const done = matches.filter((m: any) => m.winner_team);
  let standings: { name: string; wins: number }[] = [];
  if (teams.length) {
    const teamOf = new Map<string, string>();
    for (const tm of teams) {
      for (const uid of [tm.captain_id, tm.male_1_id, tm.male_2_id, tm.female_1_id, tm.female_2_id]) {
        if (uid) teamOf.set(uid, tm.name);
      }
    }
    const wins = new Map<string, number>();
    for (const tm of teams) wins.set(tm.name, 0);
    for (const m of done) {
      const side = m.winner_team === 'team1' ? [m.team1_player1, m.team1_player2] : [m.team2_player1, m.team2_player2];
      const team = teamOf.get(side.find(Boolean));
      if (team) wins.set(team, (wins.get(team) ?? 0) + 1);
    }
    standings = [...wins.entries()].map(([name, w]) => ({ name, wins: w }));
  } else if (done.length) {
    const wins = new Map<string, number>();
    for (const m of done) {
      const side = m.winner_team === 'team1' ? [m.team1_player1, m.team1_player2] : [m.team2_player1, m.team2_player2];
      for (const uid of side) {
        if (uid) wins.set(uid, (wins.get(uid) ?? 0) + 1);
      }
    }
    standings = [...wins.entries()].map(([uid, w]) => ({ name: nameById.get(uid) ?? '?', wins: w }));
  }
  standings.sort((a, b) => b.wins - a.wins);
  const top = standings.slice(0, 3);

  const format = FORMAT_LABEL[t.format] ?? t.format ?? '—';
  const matchType = t.match_type ? String(t.match_type)[0].toUpperCase() + String(t.match_type).slice(1) : '—';
  const when = t.start_time ? fmt(t.start_time, DAY_TIME) : 'TBD';
  // What "n/m" means depends on the format: MLP fields teams, everything else
  // fields players.
  const fieldCount = teams.length ? `${teams.length}` : `${players.length}`;
  const fieldMax = t.max_players ? `/${t.max_players}` : '';
  const fieldLabel = teams.length ? 'TEAMS' : 'PLAYERS';

  const statusLine =
    t.status === 'registration'
      ? `Registration open — ${fieldCount}${fieldMax} ${teams.length ? 'teams' : 'players'} in`
      : t.status === 'active'
        ? `In progress — ${done.length} of ${matches.length} matches played`
      : t.status === 'completed' ? 'Finished'
      : t.status === 'cancelled' ? 'Cancelled' : t.status;

  const leaderText = top.length && done.length
    ? (t.status === 'completed'
        ? `Champions: ${top[0].name} (${top[0].wins}W)`
        : `Leading: ${top.map(s => `${s.name} ${s.wins}W`).join(', ')}`)
    : '';

  return {
    title: t.status === 'registration' ? `${t.name} — registration open` : t.name,
    description: `${statusLine} · ${format} ${matchType.toLowerCase()} · ${when}`
      + (t.location_name ? ` · ${t.location_name}` : '')
      + (leaderText ? ` · ${leaderText}` : ''),
    fingerprint: JSON.stringify({ st: t.status, d: done.length, s: standings, p: players.length }),
    body: (
      <OgChrome brand={BRAND} site={SITE_LABEL} colors={PALETTE}>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }}>
          <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, color: PALETTE.accent, letterSpacing: 1 }}>
            {statusLine.toUpperCase()}
          </div>
          <div style={{ display: 'flex', fontSize: t.name.length > 26 ? 40 : 52, fontWeight: 800, color: PALETTE.text, marginTop: 8 }}>
            {t.name}
          </div>
          <div style={{ display: 'flex', marginTop: 24 }}>
            <OgStat label="WHEN" value={when} colors={PALETTE} />
            <OgStat label="FORMAT" value={`${format} · ${matchType}`} colors={PALETTE} />
            <OgStat label={fieldLabel} value={`${fieldCount}${fieldMax}`} colors={PALETTE} />
            {t.location_name ? <OgStat label="WHERE" value={String(t.location_name).slice(0, 20)} colors={PALETTE} /> : null}
          </div>

          {/* Live standings — the reason to tap a card for a running event. */}
          {top.length > 0 && done.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 26 }}>
              <div style={{ display: 'flex', fontSize: 20, color: PALETTE.faint, letterSpacing: 1 }}>
                {t.status === 'completed' ? 'FINAL STANDINGS' : 'STANDINGS'}
              </div>
              <div style={{ display: 'flex', marginTop: 8 }}>
                {top.map((s, i) => (
                  <div key={s.name} style={{
                    display: 'flex', backgroundColor: PALETTE.panel, borderRadius: 12,
                    padding: '10px 18px', marginRight: 12, fontSize: 24,
                    color: i === 0 ? PALETTE.accent : PALETTE.text, fontWeight: i === 0 ? 800 : 400,
                  }}>
                    {`${i + 1}. ${s.name}`}
                    <div style={{ display: 'flex', marginLeft: 10, fontWeight: 700, color: PALETTE.muted }}>
                      {`${s.wins}W`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(top.length === 0 || done.length === 0) && (
            <div style={{ display: 'flex', fontSize: 24, color: PALETTE.muted, marginTop: 24 }}>
              {players.length
                ? `Playing (${players.length}${fieldMax}): ${clampNames(players, 7)}`
                : t.status === 'registration' ? 'No one has registered yet — be first.' : ''}
            </div>
          )}
        </div>
      </OgChrome>
    ),
  };
}
