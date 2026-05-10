import React, { useEffect, useState } from 'react';
import { ScrollView, View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { League, LeagueSeason, RootStackParamList, Tournament } from '../types';
import { FORMAT_META } from '../lib/tournament';
import { useTheme } from '../lib/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'LeagueInfo'>;
  route:      RouteProp<RootStackParamList, 'LeagueInfo'>;
};

export default function LeagueInfoScreen({ route }: Props) {
  const { leagueId } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [league, setLeague]           = useState<League | null>(null);
  const [seasons, setSeasons]         = useState<LeagueSeason[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [matchCount, setMatchCount]   = useState(0);
  const [loading, setLoading]         = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    const [lRes, sRes, tRes, mCount, mtCount] = await Promise.all([
      supabase.from('leagues').select('*').eq('id', leagueId).single(),
      supabase.from('league_seasons').select('*').eq('league_id', leagueId).order('start_date', { ascending: false }),
      supabase.from('tournaments').select('*').eq('league_id', leagueId).order('created_at', { ascending: false }),
      supabase.from('league_members').select('id', { count: 'exact', head: true }).eq('league_id', leagueId),
      supabase.from('matches').select('id', { count: 'exact', head: true }).eq('league_id', leagueId),
    ]);
    setLeague(lRes.data as League);
    setSeasons((sRes.data ?? []) as LeagueSeason[]);
    setTournaments((tRes.data ?? []) as Tournament[]);
    setMemberCount(mCount.count ?? 0);
    setMatchCount(mtCount.count ?? 0);
    setLoading(false);
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={c.primary} />;
  if (!league) return <Text style={S.empty}>League not found.</Text>;

  const activeSeason = seasons.find(s => s.status === 'active' || s.status === 'upcoming');
  const completedSeasons = seasons.filter(s => s.status === 'completed');

  // Format tournament breakdown — count by format
  const tFormats = new Map<string, number>();
  tournaments.forEach(t => tFormats.set(t.format, (tFormats.get(t.format) ?? 0) + 1));

  return (
    <ScrollView style={S.container} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Text style={S.pageTitle}>How {league.name} works</Text>
      <Text style={S.pageSub}>
        Snapshot of this league's setup, scoring rules, and current state.
      </Text>

      {/* ── At a glance ─────────────────────────────────────── */}
      <Section S={S} title="At a glance">
        <Row S={S} label="Privacy"     value={league.is_open ? '🌐 Public — anyone can join' : '🔒 Private — invite or request only'} />
        <Row S={S} label="Members"     value={`${memberCount}`} />
        <Row S={S} label="Matches played" value={`${matchCount}`} />
        <Row S={S} label="Home court"  value={league.home_court ?? 'Not set'} />
      </Section>

      {/* ── Match scoring + PLUPR ───────────────────────────── */}
      <Section S={S} title="Match scoring & PLUPR">
        <Para S={S}>
          Every recorded match updates each participant's <Text style={S.bold}>PLUPR</Text> (Pickleague Universal
          Pickleball Rating). Singles matches compare the two players directly. Doubles matches compare the
          <Text style={S.bold}> average</Text> PLUPR of each pair, then apply the same delta to both teammates.
        </Para>
        <Para S={S}>
          The expected score for each side is{' '}
          <Text style={S.mono}>1 / (1 + 10^((opp − you) / 2.0))</Text>. Each match's actual delta is multiplied by a
          score-margin factor (close games count less than blowouts) and a K factor that decays with match count.
        </Para>
        <Para S={S}>
          A match's <Text style={S.bold}>before</Text> and <Text style={S.bold}>after</Text> PLUPR are saved on the
          match row so player profiles and match history can show rating progression over time. See "Scoring Algo" in
          Settings for the full formula.
        </Para>
      </Section>

      {/* ── Home court ─────────────────────────────────────── */}
      <Section S={S} title="Home court">
        {league.home_court ? (
          <>
            <Para S={S}>
              This league's home court is <Text style={S.bold}>{league.home_court}</Text>. Any match recorded at this
              location is tagged as a home-court game; everywhere else counts as away. Editing the home court
              re-tags every past match in this league.
            </Para>
          </>
        ) : (
          <Para S={S}>
            No home court is set for this league. Each match entry must include its own location, and home/away
            tagging is disabled until a home court is chosen.
          </Para>
        )}
      </Section>

      {/* ── Seasons & lock-in periods ──────────────────────── */}
      <Section S={S} title="Seasons & lock-in periods">
        {seasons.length === 0 ? (
          <Para S={S}>
            This league has not run any seasons yet. Admins can start one to track standings over discrete
            lock-in periods, with median-rank scoring and a per-period PLUPR reset.
          </Para>
        ) : (
          <>
            <Para S={S}>
              Each season runs for a fixed number of weeks with a regular <Text style={S.bold}>lock-in cadence</Text>.
              At the end of every lock-in period, an admin captures a snapshot of the standings (rank by wins, PLUPR as tiebreak).
              At the end of the season, each player's <Text style={S.bold}>median snapshot rank</Text> across periods becomes
              their season score — lowest median wins.
            </Para>
            {activeSeason && (
              <View style={S.callout}>
                <Text style={S.calloutTitle}>Current season — {activeSeason.name}</Text>
                <Text style={S.calloutLine}>{activeSeason.total_weeks} weeks · lock-in every {activeSeason.lock_frequency_weeks}w · {activeSeason.total_periods} periods</Text>
                <Text style={S.calloutLine}>
                  {fmtDate(activeSeason.start_date)} → {fmtDate(activeSeason.end_date)} · {activeSeason.status}
                </Text>
              </View>
            )}
            {completedSeasons.length > 0 && (
              <Para S={S}>
                <Text style={S.bold}>{completedSeasons.length} past season{completedSeasons.length === 1 ? '' : 's'}</Text>{' '}
                on file. Open Season Standings on a past season to see all four lock-in snapshots and the final
                median-rank standings.
              </Para>
            )}
          </>
        )}
      </Section>

      {/* ── Events ─────────────────────────────────────────── */}
      <Section S={S} title="Scheduled play & events">
        <Para S={S}>
          Members propose play sessions as <Text style={S.bold}>events</Text>. An event has 2–6 candidate time slots;
          everyone votes for the slots they can make. Once voting closes, an organizer confirms the winning slot and
          the event becomes <Text style={S.bold}>Scheduled</Text>. After midnight ends the play day, the event is
          considered <Text style={S.bold}>Past</Text>.
        </Para>
      </Section>

      {/* ── Tournaments ───────────────────────────────────── */}
      {tournaments.length > 0 && (
        <Section S={S} title="Tournaments in this league">
          <Para S={S}>
            <Text style={S.bold}>{tournaments.length} tournament{tournaments.length === 1 ? '' : 's'}</Text> have been run under this league.
          </Para>
          <View style={{ gap: 4 }}>
            {[...tFormats.entries()].map(([fmt, count]) => {
              const meta = (FORMAT_META as any)[fmt];
              return (
                <Text key={fmt} style={S.formatLine}>
                  {meta?.icon ?? '🎾'}  {meta?.label ?? fmt} — {count}
                </Text>
              );
            })}
          </View>
          <Para S={S}>
            Tournament matches do <Text style={S.bold}>not</Text> affect league PLUPR — they're tracked separately,
            with their own bracket structure, round-by-round results, and per-format advancement rules. Open a
            tournament's "How this works" page for the specifics.
          </Para>
        </Section>
      )}
    </ScrollView>
  );
}

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function Section({ S, title, children }: { S: any; title: string; children: React.ReactNode }) {
  return (
    <View style={S.section}>
      <Text style={S.sectionTitle}>{title}</Text>
      <View style={{ gap: 10 }}>{children}</View>
    </View>
  );
}

function Row({ S, label, value }: { S: any; label: string; value: string }) {
  return (
    <View style={S.row}>
      <Text style={S.rowLabel}>{label}</Text>
      <Text style={S.rowValue}>{value}</Text>
    </View>
  );
}

function Para({ S, children }: { S: any; children: React.ReactNode }) {
  return <Text style={S.para}>{children}</Text>;
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:    { flex: 1, backgroundColor: c.bg },
    pageTitle:    { fontSize: 22, fontWeight: '800', color: c.text, marginBottom: 4 },
    pageSub:      { fontSize: 14, color: c.textMuted, marginBottom: 18 },
    section:      { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    sectionTitle: { fontSize: 13, fontWeight: '800', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },
    row:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingVertical: 4 },
    rowLabel:     { fontSize: 13, color: c.textMuted, fontWeight: '600' },
    rowValue:     { fontSize: 14, color: c.text, fontWeight: '600', flex: 1, textAlign: 'right' },
    para:         { fontSize: 14, color: c.text, lineHeight: 20 },
    bold:         { fontWeight: '800' },
    mono:         { fontFamily: 'monospace', fontSize: 13, color: c.textSub },
    callout:      { backgroundColor: c.primaryLight, borderRadius: 10, padding: 12, gap: 4, borderWidth: 1, borderColor: c.primary + '44' },
    calloutTitle: { fontSize: 13, fontWeight: '700', color: c.primary },
    calloutLine:  { fontSize: 13, color: c.text },
    formatLine:   { fontSize: 13, color: c.textSub, fontWeight: '600' },
    empty:        { textAlign: 'center', marginTop: 60, color: c.textMuted, fontSize: 15 },
  });
}
