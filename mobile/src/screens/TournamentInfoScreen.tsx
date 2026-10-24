import React, { useEffect, useLayoutEffect, useState } from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { Tournament, RootStackParamList } from '../types';
import { FORMAT_META } from '../lib/tournament';
import { useTheme } from '../lib/ThemeContext';
import EmptyState from '../components/EmptyState';
import { ErrorState, LoadingState, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentInfo'>;
  route:      RouteProp<RootStackParamList, 'TournamentInfo'>;
};

// Per-format explainers — what's shown depends on this tournament's format.
// UI compaction P5b fixed the stale copy: standings follow the canonical
// chain (wins, head-to-head between exactly 2 tied, point differential, seed;
// lib/tournamentTiebreakers.ts), not PLUPR; pool-play advancement depends on
// the configured playoff (playoffLines below); MLP teams are 4 players with
// sub-matches; and the partner-finder modal these pages pointed to is gone
// (partners pair up in the tournament's Pairs / Teams section).
const CANONICAL_TIEBREAK = 'Standings: wins first, then head-to-head when exactly two are tied, then point differential, then seed.';

const FORMAT_EXPLAINERS: Record<Tournament['format'], { headline: string; flow: string[]; advancement: string[] }> = {
  round_robin: {
    headline: 'Every player (or team) faces every other one exactly once.',
    flow: [
      'A circle-method schedule pairs every entrant with every other entrant.',
      CANONICAL_TIEBREAK,
      'No elimination: everyone plays every round.',
    ],
    advancement: [
      'With no playoff, the standings table is the result.',
    ],
  },
  single_elimination: {
    headline: 'One loss and you\'re out.',
    flow: [
      'Players are seeded into a bracket whose size is the next power of 2 above the entrant count (extra slots become BYEs).',
      'Round 1 pairings: top seed vs bottom seed, 2 vs second-from-bottom, etc.',
      'Each round halves the field; the winner of the final round takes the title.',
    ],
    advancement: [
      'Win → advance to next round. Lose → eliminated.',
      'BYEs auto-advance their holder. With PLUPR seeding the byes reward the top seeds; with a random draw they\'re pure luck.',
    ],
  },
  double_elimination: {
    headline: 'Two losses to be eliminated — losers get a second chance.',
    flow: [
      'Same Round 1 pairings as single-elim.',
      'A player who loses drops to the losers bracket and keeps playing.',
      'Champion is the player who never loses, OR the losers-bracket survivor who beats them.',
    ],
    advancement: [
      'First loss → moved to losers bracket.',
      'Second loss → eliminated.',
      'Losers bracket finalist plays the winners bracket champion in the grand final.',
      'Non-power-of-2 fields use first-round BYEs — top seeds under PLUPR seeding, pure luck under a random draw.',
    ],
  },
  pool_play: {
    headline: 'Round-robin pools, then (optionally) a playoff from the top finishers.',
    flow: [
      'Players are split into balanced pools (snake draft under PLUPR seeding, otherwise random).',
      'Inside each pool, every entrant plays every other entrant once.',
      'Pool standings: wins first, then head-to-head when exactly two are tied, then point differential, then seed.',
    ],
    advancement: [],
  },
  mlp: {
    headline: 'Teams of 4 (2 men, 2 women) play team meetings.',
    flow: [
      'Captains build fixed teams in the Teams section before the bracket is drawn.',
      'Each team meeting is 4 doubles sub-matches: men\'s, women\'s and 2 mixed. A 2-2 meeting is settled by a singles dreambreaker.',
      'Team standings are by sub-matches won.',
    ],
    advancement: [],
  },
  mlp_random: {
    headline: 'Drafted teams of 4 (2 men, 2 women) play team meetings.',
    flow: [
      'The organizer drafts approved players into teams (random or snake draft).',
      'Each team meeting is 4 doubles sub-matches: men\'s, women\'s and 2 mixed. A 2-2 meeting is settled by a singles dreambreaker.',
      'Team standings are by sub-matches won.',
    ],
    advancement: [],
  },
  rotating_partners: {
    headline: 'Doubles where partners rotate every round.',
    flow: [
      'Players are arrayed and rotated each round so every player gets a fresh partner.',
      'Within each group of four, the pairing variant cycles: (a,b) vs (c,d), then (a,c) vs (b,d), then (a,d) vs (b,c).',
      'Designed for social/league-night play rather than a single champion.',
    ],
    advancement: [
      'No bracket — every match is independent.',
      'Standings are per player: wins (games, in best-of matches), then fewer losses, then PLUPR.',
    ],
  },
};

/** The playoff that follows group play, from the tournament's settings. */
function playoffLines(t: Tournament): string[] {
  if (t.format === 'mlp' || t.format === 'mlp_random') {
    const mpf = t.mlp_play_format;
    const groups = mpf === 'pool_play' || mpf === 'pool_play_playoff'
      ? `Group play runs in ${t.mlp_pool_count ?? 2} pools.`
      : 'Group play is a round robin: every team meets every other team.';
    if (mpf === 'round_robin_playoff' || mpf === 'pool_play_playoff') {
      return [groups, `The top ${t.mlp_playoff_teams ?? 4} teams by sub-matches won advance to a playoff once group play is complete.`];
    }
    return [groups, 'No playoff: the team standings are the final order.'];
  }
  if (t.format !== 'round_robin' && t.format !== 'pool_play') return [];
  const third = t.playoff_third_place ? ', plus a third-place match' : '';
  switch (t.playoff_format ?? 'none') {
    case 'top_2': return ['The top 2 play the final; 3rd and 4th play for third place.'];
    case 'top_4': return [`The top 4 play semifinals, then the final${third}.`];
    case 'top_8': return [`The top 8 play quarterfinals, semifinals and the final${third}.`];
    case 'top_1_per_pool': return ['Each pool winner advances to the playoff, seeded across pools.'];
    case 'top_2_per_pool': return [
      'The top 2 of each pool advance to the playoff, seeded across pools.',
      'With 2 pools: A1 vs B2 and B1 vs A2 in the semifinals; the winners meet in the final.',
    ];
    default: return [t.format === 'pool_play'
      ? 'No playoff: the pool tables are the final result.'
      : 'No playoff: the standings table is the result.'];
  }
}

export default function TournamentInfoScreen({ navigation, route }: Props) {
  const { tournamentId, tournamentName: paramName } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [t, setT]         = useState<Tournament | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The navigator's title is built from the tournamentName param, which a
  // clean web URL (/tournaments/:id/info) doesn't have ("How undefined
  // works"). Use the loaded name, then the param, then a neutral title. The
  // header carries the title; it isn't repeated in the page (as LeagueInfo).
  const name = t?.name || paramName;
  useLayoutEffect(() => {
    navigation.setOptions({ title: name ? `How ${name} works` : 'How this tournament works' });
  }, [navigation, name]);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const [tournament, mRes] = await Promise.all([
        sbCall(() => supabase.from('tournaments').select('*').eq('id', tournamentId).single()),
        supabase.from('tournament_registrations').select('id', { count: 'exact', head: true }).eq('tournament_id', tournamentId).eq('status', 'approved'),
      ]);
      setT(tournament as Tournament);
      setMemberCount(mRes.count ?? 0);
      setLoadError(null);
    } catch (e) {
      // Was a discarded error rendering as "Tournament not found."
      setLoadError(friendlySbMessage(e));
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState label="Loading…" />;
  if (loadError && !t) {
    return (
      <ErrorState
        iconName="offline"
        error={null}
        message={`Couldn't load this tournament. ${loadError}`}
        onRetry={() => { setLoading(true); void load(); }}
      />
    );
  }
  if (!t) return <EmptyState title="Tournament not found." />;

  const meta = FORMAT_META[t.format];
  const expl = FORMAT_EXPLAINERS[t.format];
  // Round robin's static line covers "no playoff"; a configured playoff
  // replaces it. Pool play and MLP always read their playoff settings.
  const rrPlayoff = t.format === 'round_robin' && (t.playoff_format ?? 'none') !== 'none';
  const advancement = rrPlayoff
    ? playoffLines(t)
    : [...expl.advancement, ...(t.format === 'round_robin' ? [] : playoffLines(t))];

  return (
    <ScrollView style={S.container} contentContainerStyle={S.content}>
      {/* ── Format headline ────────────────────────────────── */}
      <View style={S.headline}>
        <Icon name={meta.iconName} size={28} color={c.primary} />
        <View style={{ flex: 1 }}>
          <Text style={S.headlineLabel}>{meta.label}</Text>
          <Text style={S.headlineDesc}>{expl.headline}</Text>
        </View>
      </View>

      {/* ── At a glance ────────────────────────────────────── */}
      <Section S={S} title="At a glance">
        <Row S={S} label="Match type"        value={t.match_type === 'doubles' ? 'Doubles' : 'Singles'} />
        <Row S={S} label="Seeding"           value={t.seeding === 'elo' ? 'PLUPR-seeded' : 'Random draw'} iconName={t.seeding === 'elo' ? 'chart' : 'dice'} />
        {t.format === 'pool_play' && <Row S={S} label="Pools" value={`${t.pool_count} pool${t.pool_count === 1 ? '' : 's'}`} />}
        {t.partner_rotation && <Row S={S} label="Partner rotation" value={t.partner_rotation.replace('_', ' ')} />}
        <Row S={S} label="Registration"      value={t.registration_mode === 'invite_only' ? 'Invite only' : 'Request to join'} iconName={t.registration_mode === 'invite_only' ? 'lock' : 'edit'} />
        {/* The identity row dropped the old "Registration closes" and "~Nh
            expected" header lines (P5b), so they live here. Shown only when
            set: never a TBD. */}
        {t.status === 'registration' && t.registration_closes_at && (
          <Row
            S={S}
            label={Date.now() >= new Date(t.registration_closes_at).getTime() ? 'Registration closed' : 'Registration closes'}
            value={new Date(t.registration_closes_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          />
        )}
        {t.expected_length_hours != null && t.expected_length_hours > 0 && (
          <Row S={S} label="Expected length" value={`~${t.expected_length_hours}h`} />
        )}
        {t.min_players != null && <Row S={S} label="Min players"   value={`${t.min_players}`} />}
        {t.max_players != null && <Row S={S} label="Max players"   value={`${t.max_players}`} />}
        {memberCount > 0 && <Row S={S} label="Approved players"  value={`${memberCount}`} />}
        <Row S={S} label="Status"            value={statusLabel(t.status)} />
      </Section>

      {/* ── Flow of play ──────────────────────────────────── */}
      <Section S={S} title="Flow of play">
        {expl.flow.map((line, i) => (
          <BulletLine key={i} S={S} index={i + 1} text={line} />
        ))}
      </Section>

      {/* ── Advancement / how winners are determined ──────── */}
      <Section S={S} title={t.format === 'rotating_partners' || (t.format === 'round_robin' && !rrPlayoff) ? 'Standings' : 'Advancement'}>
        {advancement.map((line, i) => (
          <Para key={i} S={S}>• {line}</Para>
        ))}
      </Section>

      {/* ── Seeding details ──────────────────────────────── */}
      <Section S={S} title="Seeding rules">
        <Para S={S}>
          {t.seeding === 'elo'
            ? 'Players are sorted by current PLUPR rating before pairing. The strongest seed plays the weakest in round 1, second-strongest plays second-weakest, and so on. Pool play uses a snake-draft (1→A, 2→B, 3→B, 4→A …) so every pool gets a balanced spread of strength.'
            : 'Players are shuffled into a random order before pairing — no PLUPR bias.'}
        </Para>
      </Section>

      {/* ── PLUPR impact ────────────────────────────────────── */}
      <Section S={S} title="PLUPR impact">
        <Para S={S}>
          Tournament matches <Text style={S.bold}>count toward PLUPR</Text>: when a score is recorded, ratings update the same way a league match does.
          Paying out a completed tournament's prizes also applies a PLUPR bonus to its finishers.
        </Para>
      </Section>

      {/* ── Doubles partner rules ─────────────────────────── */}
      {t.match_type === 'doubles' && (
        <Section S={S} title="Doubles partner rules">
          {t.format === 'mlp' && (
            <Para S={S}>
              <Text style={S.bold}>Fixed teams</Text> — a captain creates a team in the tournament's Teams section and invites
              players (2 men, 2 women), or you ask to join a team there. Rosters lock when the bracket is drawn.
            </Para>
          )}
          {t.format === 'mlp_random' && (
            <Para S={S}>
              <Text style={S.bold}>Drafted teams</Text> — you don't pick: the organizer drafts every approved player into a team.
            </Para>
          )}
          {t.format === 'rotating_partners' && (
            <Para S={S}>
              <Text style={S.bold}>Rotating partners</Text> — you don't pick a partner. The schedule rotates pairings every round
              so every player partners with several different people across the event.
            </Para>
          )}
          {t.format !== 'mlp' && t.format !== 'mlp_random' && t.format !== 'rotating_partners' && (
            <Para S={S}>
              {t.team_creation === 'random'
                ? 'The organizer draws random pairs from the approved players before the bracket is locked.'
                : 'Pair up in the tournament\'s Pairs section before the bracket is locked: create a pair and invite your partner, or ask to join one.'}
              {' '}Once locked, you're a team for the duration.
            </Para>
          )}
        </Section>
      )}
    </ScrollView>
  );
}

function statusLabel(s: Tournament['status']): string {
  if (s === 'registration') return 'Registration open';
  if (s === 'active')       return 'In progress';
  if (s === 'completed')    return 'Ended';
  return 'Cancelled';
}

// Section titles use the foundation SectionHeader (was a hand-rolled uppercase
// label): it brings the header role and the small-text scale cap.
function Section({ S, title, children }: { S: any; title: string; children: React.ReactNode }) {
  return (
    <View style={S.section}>
      <SectionHeader title={title} />
      <View style={S.sectionBody}>{children}</View>
    </View>
  );
}

// `iconName`: a glyph before the value, in the value's colour (decorative:
// the value's words carry the meaning).
function Row({ S, label, value, iconName }: { S: any; label: string; value: string; iconName?: IconName }) {
  const { colors: c } = useTheme();
  return (
    <View style={S.row}>
      <Text style={S.rowLabel}>{label}</Text>
      {iconName ? (
        <View style={S.rowValueWithIcon}>
          <Icon name={iconName} size={14} color={c.text} />
          <Text style={[S.rowValue, S.rowValueShrink]}>{value}</Text>
        </View>
      ) : (
        <Text style={S.rowValue}>{value}</Text>
      )}
    </View>
  );
}

function Para({ S, children }: { S: any; children: React.ReactNode }) {
  return <Text style={S.para}>{children}</Text>;
}

function BulletLine({ S, index, text }: { S: any; index: number; text: string }) {
  return (
    <View style={S.bulletRow}>
      <View style={S.bulletNum}><Text style={S.bulletNumText}>{index}</Text></View>
      <Text style={S.bulletText}>{text}</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  // UI compaction P5b token sweep: SPACE / RADIUS, FONT sizes only (no 18 /
  // 22), theme colours only, no shadows.
  return StyleSheet.create({
    container:    { flex: 1, backgroundColor: c.bg },
    content:      { padding: SPACE.lg, paddingBottom: SPACE.xl * 2 },
    headline:     { backgroundColor: c.primaryLight, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.md, flexDirection: 'row', alignItems: 'center', gap: SPACE.md, borderWidth: HAIRLINE, borderColor: c.primary },
    headlineLabel:{ fontSize: FONT.size.xl, fontWeight: FONT.weight.heavy, color: c.primary },
    headlineDesc: { fontSize: FONT.size.base, color: c.text, marginTop: SPACE.xxs, lineHeight: FONT.line.tight },
    section:      { backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.md, borderWidth: HAIRLINE, borderColor: c.border },
    sectionBody:  { gap: SPACE.sm },
    row:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACE.md, paddingVertical: SPACE.xs },
    rowLabel:     { fontSize: FONT.size.base, color: c.textMuted, fontWeight: FONT.weight.semibold },
    rowValue:     { fontSize: FONT.size.md, color: c.text, fontWeight: FONT.weight.semibold, flex: 1, textAlign: 'right' },
    rowValueWithIcon: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: SPACE.xs },
    rowValueShrink: { flex: 0, flexShrink: 1 },
    para:         { fontSize: FONT.size.md, color: c.text, lineHeight: FONT.line.normal },
    bold:         { fontWeight: FONT.weight.heavy },
    bulletRow:    { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm },
    bulletNum:    { width: 22, height: 22, borderRadius: RADIUS.pill, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
    bulletNumText:{ fontSize: FONT.size.xs, fontWeight: FONT.weight.heavy, color: c.textInverse },
    bulletText:   { flex: 1, fontSize: FONT.size.md, color: c.text, lineHeight: FONT.line.normal },
  });
}
