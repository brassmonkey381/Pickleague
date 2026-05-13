import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';

/**
 * Renders the *expected* playoff bracket for an MLP tournament with a
 * `_playoff` variant. Pulls current standings; for slots where the standing
 * is known (matches in that pool/RR are done), uses the actual team name.
 * For undetermined slots, shows a placeholder like "Pool A #1" or "RR #2".
 *
 * Always rendered when format is `round_robin_playoff` or `pool_play_playoff`
 * — gives admins and players a "what's coming" view from day 1.
 */

type Props = {
  tournamentId: string;
  mlpPlayFormat: 'round_robin_playoff' | 'pool_play_playoff';
  poolCount: number;
  playoffTeams: number;     // 2 / 4 / 8
};

type StandingsRow = {
  team_id: string;
  team_name: string;
  seed: number;
  pool_letter: string | null;
  sub_matches_won: number;
  sub_matches_lost: number;
};

type Slot = { teamName: string; placeholder: boolean };
type Pairing = { left: Slot; right: Slot; label: string };

export default function MlpPlayoffPreview({
  tournamentId, mlpPlayFormat, poolCount, playoffTeams,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const [rows, setRows]       = useState<StandingsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [poolsDone, setPoolsDone] = useState(false);
  const [errMsg, setErrMsg]   = useState<string | null>(null);

  useFocusEffect(useCallback(() => { load(); }, [tournamentId, mlpPlayFormat]));

  async function load() {
    setLoading(true);
    setErrMsg(null);
    const [stRes, mRes] = await Promise.all([
      supabase.rpc('mlp_team_standings', { p_tournament_id: tournamentId }),
      supabase
        .from('tournament_matches')
        .select('id, status, round:tournament_rounds!inner(round_type)')
        .eq('tournament_id', tournamentId),
    ]);
    if (stRes.error) {
      // eslint-disable-next-line no-console
      console.warn('[MlpPlayoffPreview] mlp_team_standings error', stRes.error);
      const missing = /does not exist|Could not find the function|PGRST202/i.test(stRes.error.message ?? '');
      setErrMsg(missing
        ? 'mlp_team_standings RPC not deployed. Run supabase/migration_fix_mlp_standings.sql.'
        : (stRes.error.message ?? 'Failed to load standings.'));
    }
    setRows((stRes.data ?? []) as StandingsRow[]);
    const matches = (mRes.data ?? []) as any[];
    const poolMatches = matches.filter(m =>
      m.round?.round_type === 'pool' || m.round?.round_type === 'winners');
    setPoolsDone(poolMatches.length > 0 && poolMatches.every(m => m.status === 'completed'));
    setLoading(false);
  }

  // ── Compute the would-be pairings ────────────────────────────────
  function buildPairings(): Pairing[] {
    // Determine the seeded advancing slots (1..playoffTeams).
    const slots: Slot[] = [];

    if (mlpPlayFormat === 'pool_play_playoff') {
      // For pool play: top-per-pool, then ordered by pool_rank, pool_letter.
      // E.g. 2 pools, 2 advance each: A1, B1, A2, B2 → bracket A1 vs B2, B1 vs A2.
      const topPerPool = Math.max(1, Math.floor(playoffTeams / poolCount));
      // Group standings by pool
      const byPool = new Map<string, StandingsRow[]>();
      for (const r of rows) {
        if (!r.pool_letter) continue;
        if (!byPool.has(r.pool_letter)) byPool.set(r.pool_letter, []);
        byPool.get(r.pool_letter)!.push(r);
      }
      const pools = [...byPool.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([letter, list]) => ({ letter, list }));

      // Fill seeded slots in order of pool_rank (1st of each pool, then 2nd, ...).
      for (let rank = 1; rank <= topPerPool; rank++) {
        for (const { letter, list } of pools) {
          if (slots.length >= playoffTeams) break;
          const team = list[rank - 1];
          if (team) {
            slots.push({ teamName: team.team_name, placeholder: false });
          } else {
            slots.push({ teamName: `Pool ${letter} #${rank}`, placeholder: true });
          }
        }
      }
      // Pad with generic placeholders if we still don't have enough.
      while (slots.length < playoffTeams) {
        slots.push({ teamName: `TBD ${slots.length + 1}`, placeholder: true });
      }
    } else {
      // round_robin_playoff: top N from a flat RR (rows already sorted by W-L).
      // Only meaningful when poolsDone — otherwise show generic "RR #X" placeholders.
      const sorted = [...rows].sort((a, b) =>
        (b.sub_matches_won - a.sub_matches_won)
        || (a.sub_matches_lost - b.sub_matches_lost)
        || (a.seed - b.seed)
      );
      for (let i = 0; i < playoffTeams; i++) {
        const team = sorted[i];
        if (team && poolsDone) {
          slots.push({ teamName: team.team_name, placeholder: false });
        } else {
          slots.push({ teamName: `RR #${i + 1}`, placeholder: true });
        }
      }
    }

    // Build round-1 pairings: 1 vs N, 2 vs N-1, ...
    const pairings: Pairing[] = [];
    const N = slots.length;
    const roundLabel = N === 8 ? 'Quarterfinal' : N === 4 ? 'Semifinal' : N === 2 ? 'Final' : `Round of ${N}`;
    for (let i = 0; i < N / 2; i++) {
      pairings.push({
        left:  slots[i],
        right: slots[N - 1 - i],
        label: `${roundLabel} ${i + 1}`,
      });
    }
    return pairings;
  }

  const pairings = buildPairings();
  const playoffExists = rows.length > 0 && poolsDone; // optimistic — not authoritative

  if (loading) return <ActivityIndicator style={{ marginVertical: 16 }} color={c.primary} />;

  // Sorted standings for the table view (same sort as the bracket seeding).
  const sortedRows = [...rows].sort((a, b) => {
    if (a.pool_letter && b.pool_letter) {
      const cmp = a.pool_letter.localeCompare(b.pool_letter);
      if (cmp !== 0) return cmp;
    }
    return (b.sub_matches_won - a.sub_matches_won)
        || (a.sub_matches_lost - b.sub_matches_lost)
        || (a.seed - b.seed);
  });

  return (
    <View style={S.root}>
      <Text style={S.title}>🏆 Playoff Preview</Text>
      <Text style={S.subtitle}>
        {poolsDone
          ? 'Pool / round-robin play is complete. The playoff bracket below has been seeded.'
          : 'Bracket structure for the playoff. Team names fill in as pool / round-robin standings settle. The bracket generates automatically when all pre-playoff matches finish.'}
      </Text>

      {errMsg && (
        <View style={S.errBox}>
          <Text style={S.errText}>⚠ {errMsg}</Text>
        </View>
      )}

      {/* Standings table — always shown when standings exist */}
      {sortedRows.length > 0 && (
        <View style={S.standingsTable}>
          <Text style={S.standingsTitle}>Standings</Text>
          <View style={S.standingsHeader}>
            <Text style={[S.standCell, S.standRank]}>#</Text>
            <Text style={[S.standCell, S.standName]}>Team</Text>
            <Text style={[S.standCell, S.standWL]}>W-L</Text>
          </View>
          {(() => {
            // Group by pool for pool-play, else flat ranking
            const groups: { label: string; rows: StandingsRow[] }[] = [];
            const byPool = new Map<string, StandingsRow[]>();
            for (const r of sortedRows) {
              const key = r.pool_letter ?? '__flat__';
              if (!byPool.has(key)) byPool.set(key, []);
              byPool.get(key)!.push(r);
            }
            for (const [k, list] of byPool.entries()) {
              groups.push({ label: k === '__flat__' ? 'Round Robin' : `Pool ${k}`, rows: list });
            }
            return groups.map(g => (
              <View key={g.label}>
                <Text style={S.standGroupLabel}>{g.label}</Text>
                {g.rows.map((r, i) => (
                  <View key={r.team_id} style={S.standRow}>
                    <Text style={[S.standCell, S.standRank]}>{i + 1}</Text>
                    <Text style={[S.standCell, S.standName]} numberOfLines={1}>{r.team_name}</Text>
                    <Text style={[S.standCell, S.standWL]}>{r.sub_matches_won}–{r.sub_matches_lost}</Text>
                  </View>
                ))}
              </View>
            ));
          })()}
        </View>
      )}

      {pairings.map((p, i) => (
        <View key={i} style={S.pairCard}>
          <Text style={S.pairLabel}>{p.label}</Text>
          <View style={S.pairRow}>
            <View style={S.slot}>
              <Text style={[S.slotText, p.left.placeholder && S.slotPlaceholder]}>
                {p.left.teamName}
              </Text>
            </View>
            <Text style={S.vs}>vs</Text>
            <View style={S.slot}>
              <Text style={[S.slotText, p.right.placeholder && S.slotPlaceholder]}>
                {p.right.teamName}
              </Text>
            </View>
          </View>
        </View>
      ))}

      {pairings.length > 1 && (
        <Text style={S.bracketHint}>
          Winners of each {pairings.length === 4 ? 'Quarterfinal' : 'Semifinal'} advance.
          Loser of each round drops out.
        </Text>
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:        { backgroundColor: c.surface, borderRadius: 12, padding: 14, marginTop: 12, borderWidth: 1, borderColor: c.border },
    title:       { fontSize: 16, fontWeight: '900', color: c.text, marginBottom: 4 },
    subtitle:    { fontSize: 12, color: c.textSub, lineHeight: 17, marginBottom: 12 },
    pairCard:    { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 8 },
    pairLabel:   { fontSize: 11, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
    pairRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
    slot:        { flex: 1, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: c.surface, borderRadius: 8, borderWidth: 1, borderColor: c.border },
    slotText:    { fontSize: 13, fontWeight: '700', color: c.text },
    slotPlaceholder: { color: c.textMuted, fontStyle: 'italic', fontWeight: '600' },
    vs:          { fontSize: 12, color: c.textMuted, fontWeight: '700' },
    bracketHint: { fontSize: 11, color: c.textMuted, marginTop: 4, fontStyle: 'italic' },

    errBox:   { backgroundColor: '#ffe5e5', borderRadius: 8, padding: 10, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: '#c62828' },
    errText:  { fontSize: 12, color: '#8a1414', fontWeight: '700' },

    standingsTable:    { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 12 },
    standingsTitle:    { fontSize: 12, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
    standingsHeader:   { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 4, marginBottom: 4 },
    standRow:          { flexDirection: 'row', paddingVertical: 4 },
    standGroupLabel:   { fontSize: 11, fontWeight: '700', color: c.textSub, marginTop: 6, marginBottom: 2 },
    standCell:         { fontSize: 12, color: c.text },
    standRank:         { width: 28, fontWeight: '700' },
    standName:         { flex: 1, fontWeight: '600' },
    standWL:           { width: 60, textAlign: 'right', fontWeight: '700', color: c.primary },
  });
}
