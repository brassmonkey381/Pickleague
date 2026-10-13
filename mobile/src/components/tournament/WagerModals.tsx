import React from 'react';
import { View, Text, TextInput } from 'react-native';
import { webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import ConfirmModal from '../ConfirmModal';
import ActionSheetModal from '../ActionSheetModal';
import WagerProposeModal from '../WagerProposeModal';
import { WAGERS_ENABLED } from '../../lib/features';
import { useTournamentDetailStyles } from './styles';
import type { TournamentDetailState } from './useTournamentDetail';

type Props = Pick<TournamentDetailState,
  | 'actionSheetOpen' | 'setActionSheetOpen' | 'wagerMatchPick' | 'setWagerMatchPick' | 'openMatchWager'
  | 'exactScoreOpen' | 'setExactScoreOpen' | 'exactScoreError' | 'setExactScoreError' | 'submitExactScore'
  | 'exactScoreT1' | 'setExactScoreT1' | 'exactScoreT2' | 'setExactScoreT2'
  | 'wagerOpen' | 'setWagerOpen' | 'wagerSubject' | 'setWagerSubject'>;

/**
 * The wager overlays: match action sheet (long-press a match), exact-score
 * input, and the propose modal. All gated on WAGERS_ENABLED
 * (lib/features.ts). Moved verbatim from the screen (P5a).
 */
export default function WagerModals({
  actionSheetOpen, setActionSheetOpen, wagerMatchPick, setWagerMatchPick, openMatchWager,
  exactScoreOpen, setExactScoreOpen, exactScoreError, setExactScoreError, submitExactScore,
  exactScoreT1, setExactScoreT1, exactScoreT2, setExactScoreT2,
  wagerOpen, setWagerOpen, wagerSubject, setWagerSubject,
}: Props) {
  const { S, c } = useTournamentDetailStyles();
  return (
    <>
      {/* ── Wager action sheet ── (gated: lib/features.ts) */}
      <ActionSheetModal
        visible={WAGERS_ENABLED && actionSheetOpen}
        title="Propose wager"
        subtitle={
          wagerMatchPick
            ? `${wagerMatchPick.team1Label}  vs  ${wagerMatchPick.team2Label}`
            : undefined
        }
        onClose={() => setActionSheetOpen(false)}
        actions={
          wagerMatchPick
            ? [
                {
                  label: `${wagerMatchPick.team1Label} wins`,
                  onPress: () => openMatchWager('team1', wagerMatchPick),
                },
                {
                  label: `${wagerMatchPick.team2Label} wins`,
                  onPress: () => openMatchWager('team2', wagerMatchPick),
                },
                {
                  label: 'Exact final score',
                  onPress: () => setExactScoreOpen(true),
                },
              ]
            : []
        }
      />

      {/* ── Exact-score input modal ── */}
      <ConfirmModal
        visible={exactScoreOpen}
        title="Predict exact score"
        body={
          wagerMatchPick
            ? `${wagerMatchPick.team1Label}  vs  ${wagerMatchPick.team2Label}`
            : undefined
        }
        primaryLabel="Continue"
        busy={false}
        error={exactScoreError}
        primaryDisabled={!exactScoreT1.trim() || !exactScoreT2.trim()}
        onConfirm={submitExactScore}
        onClose={() => {
          setExactScoreOpen(false);
          setExactScoreT1('');
          setExactScoreT2('');
          setExactScoreError(null);
          setWagerMatchPick(null);
        }}
        extraField={
          <View style={S.scoreRow}>
            <View style={{ flex: 1 }}>
              <Text style={S.scoreLabel}>{wagerMatchPick?.team1Label ?? 'Team 1'} score</Text>
              <TextInput
                style={[S.scoreInput, webInputFontFloor(S.scoreInput)]}
                value={exactScoreT1}
                onChangeText={setExactScoreT1}
                placeholder="0"
                placeholderTextColor={c.textMuted}
                keyboardType="number-pad"
                maxLength={3}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={S.scoreLabel}>{wagerMatchPick?.team2Label ?? 'Team 2'} score</Text>
              <TextInput
                style={[S.scoreInput, webInputFontFloor(S.scoreInput)]}
                value={exactScoreT2}
                onChangeText={setExactScoreT2}
                placeholder="0"
                placeholderTextColor={c.textMuted}
                keyboardType="number-pad"
                maxLength={3}
              />
            </View>
          </View>
        }
      />

      {/* ── Wager propose modal (Unit 1) ── */}
      <WagerProposeModal
        visible={WAGERS_ENABLED && wagerOpen}
        subject={wagerSubject}
        onClose={() => {
          setWagerOpen(false);
          setWagerSubject(null);
          setWagerMatchPick(null);
        }}
      />
    </>
  );
}
