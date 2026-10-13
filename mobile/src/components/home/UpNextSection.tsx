// UP NEXT (plan section 3): what needs you and what's on this week, in the
// order lib/agenda.ts decides (live, needs-you by deadline, then by time).
// Needs-you includes the P3 requests: a score to confirm (-> MatchHistory at
// that match; never confirmed here), a tournament invite, a drill request,
// and join requests for a league I run (-> LeagueMembers).
// 3 rows, then "Show N more" expands inline up to 10; anything past that is
// counted, never cut silently: "+N more · See all in Notifications ›" opens
// the inbox (on its Requests chip when the cut rows include requests, which
// sort last in needs-you when undated, so they are the first to be cut).
// Rows are plain navigation; their buttons open the detail screen at the
// control (decision 1).
//
// Empty (nothing this week):
//   - admin / co-admin: "Nothing this week · Propose a play day ›", which
//     opens CreateEvent (with LeaguePickerModal first when privileged in 2+
//     leagues). Same gate as Events' "+ New Event".
//   - member: "Nothing this week".
//   - non-member: HomeScreen doesn't render the section at all.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Panel, SectionHeader, EmptyState } from '@just-messin-around/expo-foundation/ui';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { agendaVisible, type AgendaResult, type AgendaRow as AgendaRowData, type AgendaTarget } from '../../lib/agenda';
import LeaguePickerModal, { type PickableLeague } from '../LeaguePickerModal';
import AgendaRow from './AgendaRow';

type Props = {
  agenda: AgendaResult;
  now: number;
  /** Leagues where I'm admin / co-admin (the "Propose a play day" gate). */
  privilegedLeagues: PickableLeague[];
  navigate: (target: AgendaTarget) => void;
  onProposePlayDay: (leagueId: string) => void;
  onDismissDrill: (sessionId: string) => void;
  /** home.tap: target slug + 0-based position. */
  onTap: (target: string, position?: number) => void;
  /** Lets HomeScreen hold back queued pop-ups while the picker is open. */
  onPickerOpenChange?: (open: boolean) => void;
  /** "+N more" past the cap: open Notifications (`requests`: some of the cut
   *  rows are requests, so land on the Requests chip). */
  onSeeAll: (requests: boolean) => void;
};

export default function UpNextSection({
  agenda,
  now,
  privilegedLeagues,
  navigate,
  onProposePlayDay,
  onDismissDrill,
  onTap,
  onPickerOpenChange,
  onSeeAll,
}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [expanded, setExpanded] = useState(false);
  const [pickerOpen, setPickerOpenState] = useState(false);
  const setPickerOpen = (open: boolean) => {
    setPickerOpenState(open);
    onPickerOpenChange?.(open);
  };
  const { shown, moreInline, beyondCap } = agendaVisible(agenda, expanded);

  const propose = () => {
    onTap('propose_play_day');
    if (privilegedLeagues.length === 1) onProposePlayDay(privilegedLeagues[0].id);
    else if (privilegedLeagues.length > 1) setPickerOpen(true);
  };

  const rowPress = (row: AgendaRowData, i: number) => () => {
    onTap('row', i);
    navigate(row.target);
  };

  return (
    <View>
      <SectionHeader title="Up next" count={agenda.total > 0 ? agenda.total : undefined} />
      <Panel padded={false}>
        {agenda.total === 0 ? (
          privilegedLeagues.length > 0 ? (
            <EmptyState compact title="Nothing this week" actionLabel="Propose a play day ›" onAction={propose} />
          ) : (
            <EmptyState compact title="Nothing this week" />
          )
        ) : (
          <>
            {shown.map((row, i) => (
              <AgendaRow
                key={row.key}
                row={row}
                now={now}
                lastRow={i === shown.length - 1 && moreInline === 0 && beyondCap === 0}
                onPress={rowPress(row, i)}
                onAction={row.action ? () => {
                  onTap(row.action!.slug ?? 'action', i);
                  navigate(row.action!.target);
                } : undefined}
                onDismiss={row.dismissibleDrillId ? () => {
                  onTap('dismiss_drill', i);
                  onDismissDrill(row.dismissibleDrillId!);
                } : undefined}
              />
            ))}
            {moreInline > 0 ? (
              <TouchableOpacity
                style={styles.more}
                activeOpacity={0.6}
                onPress={() => { onTap('show_more'); setExpanded(true); }}
                accessibilityRole="button"
                accessibilityLabel={`Show ${moreInline} more`}
              >
                <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  Show {moreInline} more
                </Text>
              </TouchableOpacity>
            ) : beyondCap > 0 ? (
              // Past the inline cap there's no agenda screen yet (plan: revisit
              // with decision 2). The cut rows can be requests (undated ones
              // sort last in needs-you) as well as this week's events, so the
              // copy stays neutral and the line goes where requests live.
              <TouchableOpacity
                style={styles.more}
                activeOpacity={0.6}
                onPress={() => { onTap('see_all_notifications'); onSeeAll((agenda.hiddenRequests ?? 0) > 0); }}
                accessibilityRole="button"
                accessibilityLabel={`${beyondCap} more. See all in Notifications`}
              >
                <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  +{beyondCap} more · See all in Notifications ›
                </Text>
              </TouchableOpacity>
            ) : null}
          </>
        )}
      </Panel>
      <LeaguePickerModal
        visible={pickerOpen}
        leagues={privilegedLeagues}
        selectedId={null}
        // Tracked apart from 'propose_play_day' (the button), so an abandoned
        // picker reads differently from a completed one.
        onPick={(id) => { onTap('propose_pick'); setPickerOpen(false); onProposePlayDay(id); }}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  more: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.md },
});
