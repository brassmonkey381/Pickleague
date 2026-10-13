// "How <league> works": the league's reference page, opened from the identity
// row's "ⓘ How it works" chip on LeagueDetail.
//
// Layout (plan section 5, LeagueInfo): the facts stay open at the top ("At a
// glance"), and every explainer is a collapsed section with a one-line summary,
// so the page opens at about one screen instead of five long cards. The header
// carries the title ("How Dinks works"); it isn't repeated in the page.
//
// Copy fixes from the plan: the home court reads through displayCourtName (the
// nickname, as everywhere else), the past-seasons line no longer promises
// "all four" snapshots (a season has as many as its lock cadence gives it), and
// events are scheduled by admins (the Events screen's "+ New Event" is
// admin/co-admin only), not proposed by members. Also: snapshots rank by
// season PLUPR, then W-L (migration_standings_sort_by_plupr.sql), not by wins.
import React, { useEffect, useLayoutEffect, useState } from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { CollapsibleSection, LoadingState, Panel } from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, RADIUS, SMALL_TEXT_MAX_SCALE, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { League, LeagueSeason, RootStackParamList, Tournament } from '../types';
import { FORMAT_META } from '../lib/tournament';
import { useTheme } from '../lib/ThemeContext';
import { displayCourtName } from '../lib/courtNickname';
import { trackSectionToggle } from '../lib/analytics';
import EmptyState from '../components/EmptyState';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'LeagueInfo'>;
  route:      RouteProp<RootStackParamList, 'LeagueInfo'>;
};

export default function LeagueInfoScreen({ navigation, route }: Props) {
  const { leagueId, leagueName: paramName } = route.params;
  const { colors: c } = useTheme();
  const t = textStyles(c);

  const [league, setLeague]           = useState<League | null>(null);
  const [seasons, setSeasons]         = useState<LeagueSeason[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  // null = the count read failed: the row is left out rather than showing 0.
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [matchCount, setMatchCount]   = useState<number | null>(null);
  const [loading, setLoading]         = useState(true);
  const [loadError, setLoadError]     = useState<string | null>(null);

  // The navigator's title is built from the leagueName param, which a clean
  // web URL (/leagues/:id/info) doesn't have ("How undefined works"). Use the
  // loaded name, then the param, then a neutral title.
  const name = league?.name || paramName;
  useLayoutEffect(() => {
    navigation.setOptions({ title: name ? `How ${name} works` : 'How this league works' });
  }, [navigation, name]);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const [leagueRow, seasonRows, tournamentRows, mCount, mtCount] = await Promise.all([
        sbCall(() => supabase.from('leagues').select('*').eq('id', leagueId).single()),
        sbCall(() => supabase.from('league_seasons').select('*').eq('league_id', leagueId).order('start_date', { ascending: false })),
        sbCall(() => supabase.from('tournaments').select('*').eq('league_id', leagueId).order('created_at', { ascending: false })),
        supabase.from('league_members').select('id', { count: 'exact', head: true }).eq('league_id', leagueId),
        supabase.from('matches').select('id', { count: 'exact', head: true }).eq('league_id', leagueId),
      ]);
      setLeague(leagueRow as League);
      setSeasons((seasonRows ?? []) as LeagueSeason[]);
      setTournaments((tournamentRows ?? []) as Tournament[]);
      // Counts are decorative here; a failed count drops its row rather than blocking.
      setMemberCount(mCount.error ? null : mCount.count ?? null);
      setMatchCount(mtCount.error ? null : mtCount.count ?? null);
      setLoadError(null);
    } catch (e) {
      // Was a discarded error rendering as "League not found.", which reads
      // as "your league was deleted".
      setLoadError(friendlySbMessage(e, "Couldn't load this league."));
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingState label="Loading…" />;
  if (loadError && !league) {
    return (
      <EmptyState
        icon="📡"
        title="Couldn't load this league"
        subtitle={loadError}
        actionLabel="Try again"
        onAction={() => { setLoading(true); void load(); }}
      />
    );
  }
  if (!league) return <EmptyState title="League not found." />;

  const activeSeason = seasons.find(s => s.status === 'active' || s.status === 'upcoming');
  const completedSeasons = seasons.filter(s => s.status === 'completed');
  const court = league.home_court ? displayCourtName(league.home_court) : '';

  // Format tournament breakdown: count by format
  const tFormats = new Map<string, number>();
  tournaments.forEach(tr => tFormats.set(tr.format, (tFormats.get(tr.format) ?? 0) + 1));

  const S = {
    para: [t.bodySub, { color: c.text }],
    bold: styles.bold,
    mono: [styles.mono, { color: c.textSub }],
  };
  const onToggle = (section: string) => (open: boolean) =>
    trackSectionToggle({ screen: 'LeagueInfo', section, open });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={styles.container}>
      {/* ── At a glance (facts, always open) ──────────────────── */}
      <Panel style={styles.glance}>
        <Text style={[t.label, styles.panelLabel]} accessibilityRole="header" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>At a glance</Text>
        <Row label="Privacy" value={league.is_open ? '🌐 Public: anyone can join' : '🔒 Private: invite or request only'} />
        {memberCount != null ? <Row label="Members" value={`${memberCount}`} /> : null}
        {matchCount != null ? <Row label="Matches played" value={`${matchCount}`} /> : null}
        {court ? <Row label="Home court" value={court} /> : null}
        {activeSeason ? <Row label="Season" value={`${activeSeason.name} · ${activeSeason.status === 'active' ? 'Active' : 'Upcoming'}`} /> : null}
      </Panel>

      {/* ── Match scoring + PLUPR ─────────────────────────────── */}
      <CollapsibleSection compact title="Match scoring & PLUPR" summary="How every match moves your rating" onToggle={onToggle('scoring')}>
        <Text style={S.para}>
          Every recorded match updates each participant's <Text style={S.bold}>PLUPR</Text> (Pickleague Universal
          Pickleball Rating). Singles matches compare the two players directly. Doubles matches compare the
          <Text style={S.bold}> average</Text> PLUPR of each pair, then apply the same delta to both teammates.
        </Text>
        <Text style={S.para}>
          PLUPR uses a <Text style={S.bold}>margin-of-victory</Text> model: from the two ratings we predict the
          point differential, <Text style={S.mono}>10 × tanh((you − opp) / 1.0)</Text>, and the delta is{' '}
          <Text style={S.mono}>K × (actual_diff − expected_diff) / 10</Text>. K decays with match count
          (0.35 → 0.22 → 0.15). A close loss to a much stronger opponent can still nudge your rating up.
        </Text>
        <Text style={S.para}>
          A match's <Text style={S.bold}>before</Text> and <Text style={S.bold}>after</Text> PLUPR are saved on the
          match row so player profiles and match history can show rating progression over time. See "Scoring Algo" in
          Settings for the full formula.
        </Text>
      </CollapsibleSection>

      {/* ── Home court ───────────────────────────────────────── */}
      <CollapsibleSection
        compact
        title="Home court"
        summary={court ? `${court} · home vs away tagging` : 'No home court yet'}
        onToggle={onToggle('home_court')}
      >
        {court ? (
          <Text style={S.para}>
            This league's home court is <Text style={S.bold}>{court}</Text>. Any match recorded at this
            location is tagged as a home-court game; everywhere else counts as away. Editing the home court
            re-tags every past match in this league.
          </Text>
        ) : (
          <Text style={S.para}>
            No home court is set for this league. Each match entry must include its own location, and home/away
            tagging is disabled until a home court is chosen.
          </Text>
        )}
      </CollapsibleSection>

      {/* ── Seasons & lock-in periods ────────────────────────── */}
      <CollapsibleSection
        compact
        title="Seasons & lock-in periods"
        summary={seasons.length === 0
          ? 'No seasons yet'
          : activeSeason
            ? `${activeSeason.name} · lock-in every ${activeSeason.lock_frequency_weeks}w`
            : `${completedSeasons.length} past season${completedSeasons.length === 1 ? '' : 's'}`}
        onToggle={onToggle('seasons')}
      >
        {seasons.length === 0 ? (
          <Text style={S.para}>
            This league has not run any seasons yet. Admins can start one to track standings over discrete
            lock-in periods, with median-rank scoring and a per-period PLUPR reset.
          </Text>
        ) : (
          <>
            <Text style={S.para}>
              Each season runs for a fixed number of weeks with a regular <Text style={S.bold}>lock-in cadence</Text>.
              At the end of every lock-in period, an admin captures a snapshot of the standings (ranked by season PLUPR, then W-L record).
              At the end of the season, each player's <Text style={S.bold}>median snapshot rank</Text> across periods becomes
              their season score: lowest median wins.
            </Text>
            {activeSeason ? (
              <View style={[styles.callout, { backgroundColor: c.primaryLight, borderColor: c.primary }]}>
                <Text style={[t.sub, { color: c.primary, fontWeight: FONT.weight.bold }]}>Current season: {activeSeason.name}</Text>
                <Text style={[t.sub, { color: c.text }]}>
                  {activeSeason.total_weeks} weeks · lock-in every {activeSeason.lock_frequency_weeks}w · {activeSeason.total_periods} periods
                </Text>
                <Text style={[t.sub, { color: c.text }]}>
                  {fmtDate(activeSeason.start_date)} → {fmtDate(activeSeason.end_date)} · {activeSeason.status === 'active' ? 'Active' : 'Upcoming'}
                </Text>
              </View>
            ) : null}
            {completedSeasons.length > 0 ? (
              <Text style={S.para}>
                <Text style={S.bold}>{completedSeasons.length} past season{completedSeasons.length === 1 ? '' : 's'}</Text>{' '}
                on file. Open Season Standings on a past season to see every lock-in snapshot and the final
                median-rank standings.
              </Text>
            ) : null}
          </>
        )}
      </CollapsibleSection>

      {/* ── Events ───────────────────────────────────────────── */}
      <CollapsibleSection compact title="Scheduled play & events" summary="Admins schedule play days; everyone votes" onToggle={onToggle('events')}>
        <Text style={S.para}>
          Admins schedule play sessions as <Text style={S.bold}>events</Text>. An event has 2–6 candidate time slots;
          everyone votes for the slots they can make. Once voting closes, an organizer confirms the winning slot and
          the event becomes <Text style={S.bold}>Scheduled</Text>. After midnight ends the play day, the event is
          considered <Text style={S.bold}>Past</Text>.
        </Text>
      </CollapsibleSection>

      {/* ── Tournaments ──────────────────────────────────────── */}
      {tournaments.length > 0 ? (
        <CollapsibleSection
          compact
          title="Tournaments in this league"
          count={tournaments.length}
          summary="Tracked separately from league PLUPR"
          onToggle={onToggle('tournaments')}
        >
          <Text style={S.para}>
            <Text style={S.bold}>{tournaments.length} tournament{tournaments.length === 1 ? '' : 's'}</Text>{' '}
            {tournaments.length === 1 ? 'has' : 'have'} been run under this league.
          </Text>
          <View style={styles.formats}>
            {[...tFormats.entries()].map(([fmt, count]) => {
              const meta = (FORMAT_META as any)[fmt];
              return (
                <Text key={fmt} style={[t.sub, { fontWeight: FONT.weight.semibold }]}>
                  {meta?.icon ?? '🥎'}  {meta?.label ?? fmt}: {count}
                </Text>
              );
            })}
          </View>
          <Text style={S.para}>
            Tournament matches do <Text style={S.bold}>not</Text> affect league PLUPR. They're tracked separately,
            with their own bracket structure, round-by-round results, and per-format advancement rules. Open a
            tournament's "How this works" page for the specifics.
          </Text>
        </CollapsibleSection>
      ) : null}
    </ScrollView>
  );
}

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function Row({ label, value }: { label: string; value: string }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <View style={[styles.row, { borderTopColor: c.border }]}>
      <Text style={t.meta} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{label}</Text>
      <Text style={[t.sub, styles.rowValue, { color: c.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // No gap: each compact CollapsibleSection brings its own SPACE.md bottom margin.
  container: { padding: SPACE.lg, paddingBottom: SPACE.xl },
  glance: { marginBottom: SPACE.md },
  panelLabel: { marginBottom: SPACE.xs },
  // Read-only fact rows: 44 tall so the panel lines up with the sections below.
  row: {
    minHeight: 44,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACE.md,
    borderTopWidth: HAIRLINE,
  },
  rowValue: { flex: 1, textAlign: 'right', fontWeight: FONT.weight.semibold },
  bold: { fontWeight: FONT.weight.heavy },
  mono: { fontFamily: 'monospace', fontSize: FONT.size.base },
  callout: { borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs, borderWidth: HAIRLINE },
  formats: { gap: SPACE.xs },
});
