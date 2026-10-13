// TournamentDetail's Manage section (plan section 5, slot 6 and "Manage
// contents"): every privileged action on the screen, in one collapsed,
// controlled CollapsibleSection that the screen opens when a step is pending
// or the You card's "Setup" line is tapped.
//
//   Registration  a checklist in the plan's order (approve requests, set the
//                 release time, pair teams, generate the preview, lock in &
//                 notify); each step carries its own inline content (the
//                 queues, the preview) and its one action.
//   Active        generate playoff, complete.
//   Completed     pay out prizes (every format).
//   Always        edit, invite, invite via code, members & roles, cancel.
//
// Rows are 44 tall (minHeight), hairline-divided; a destructive row is red and
// sits last. The developer account's tools go in their own group at the end.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { CollapsibleSection } from '@just-messin-around/expo-foundation/ui';
import { Button, type ButtonVariant } from '@just-messin-around/expo-foundation/forms';
import { HAIRLINE, RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

export type ManageRowItem = {
  key: string;
  label: string;
  /** Right-aligned meta ("2 pending", "Oct 18"). */
  meta?: string | null;
  onPress: () => void;
  danger?: boolean;
  /** Emphasised: a pending step. */
  attention?: boolean;
  disabled?: boolean;
};

export type ManageStepAction = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: ButtonVariant;
};

export type ManageStep = {
  key: string;
  label: string;
  done: boolean;
  /** The step the You card points at. */
  current?: boolean;
  /** One line under the label. */
  meta?: string | null;
  /** Inline content (the queues, the preview). */
  content?: React.ReactNode;
  actions?: ManageStepAction[];
};

export type ManageGroup = { key: string; title?: string; rows: ManageRowItem[] };

export type TournamentManageSectionProps = {
  open: boolean;
  onToggle: (next: boolean) => void;
  /** One line under the title while collapsed. */
  summary?: string;
  /** A non-actionable line at the top ("Edits are locked: …"). */
  note?: string | null;
  /** Registration checklist; empty outside registration. */
  steps?: ManageStep[];
  groups: ManageGroup[];
  /** The developer account's tools (godmode), rendered last. */
  developer?: React.ReactNode;
};

/** One 44px action row: label, optional meta, chevron. Exported for the
 *  developer group (GodmodePanel), so its rows match. */
export function ManageRow({ row, first }: { row: ManageRowItem; first: boolean }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <TouchableOpacity
      onPress={row.onPress}
      disabled={row.disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={row.meta ? `${row.label}, ${row.meta}` : row.label}
      accessibilityState={{ disabled: !!row.disabled }}
      style={[styles.row, !first && { borderTopWidth: HAIRLINE, borderTopColor: c.border }, row.disabled && styles.dim]}
    >
      <Text
        style={[
          t.sub,
          styles.label,
          { color: row.danger ? c.danger : c.text },
          (row.attention || row.danger) && styles.strong,
        ]}
        numberOfLines={1}
      >
        {row.label}
      </Text>
      {row.meta ? (
        <Text
          style={[t.meta, row.attention && { color: c.primary }]}
          numberOfLines={1}
          maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
        >
          {row.meta}
        </Text>
      ) : null}
      <Text style={[styles.chevron, { color: row.danger ? c.danger : c.textMuted }]}>›</Text>
    </TouchableOpacity>
  );
}

function StepView({ step, index, first }: { step: ManageStep; index: number; first: boolean }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const marker = step.done ? '✓' : String(index + 1);
  return (
    <View
      style={[styles.step, !first && { borderTopWidth: HAIRLINE, borderTopColor: c.border }]}
      accessibilityLabel={`Step ${index + 1}: ${step.label}${step.done ? ', done' : ''}`}
    >
      <View style={styles.stepHead}>
        <View
          style={[
            styles.marker,
            step.done
              ? { backgroundColor: c.successLight, borderColor: c.success }
              : step.current
                ? { backgroundColor: c.primary, borderColor: c.primary }
                : { backgroundColor: c.surface, borderColor: c.border },
          ]}
        >
          <Text
            style={[
              styles.markerText,
              { color: step.done ? c.success : step.current ? c.textInverse : c.textMuted },
            ]}
            maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
          >
            {marker}
          </Text>
        </View>
        <View style={styles.stepText}>
          <Text
            style={[t.sub, { color: step.done ? c.textMuted : c.text }, step.current && styles.strong]}
            numberOfLines={2}
          >
            {step.label}
          </Text>
          {step.meta ? (
            <Text style={t.meta} numberOfLines={2} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              {step.meta}
            </Text>
          ) : null}
        </View>
      </View>
      {step.content ? <View style={styles.stepBody}>{step.content}</View> : null}
      {step.actions && step.actions.length > 0 ? (
        <View style={[styles.stepBody, styles.actions]}>
          {step.actions.map(a => (
            <Button
              key={a.title}
              size="sm"
              title={a.title}
              onPress={a.onPress}
              disabled={a.disabled}
              loading={a.loading}
              variant={a.variant ?? 'primary'}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default function TournamentManageSection({
  open, onToggle, summary, note, steps = [], groups, developer,
}: TournamentManageSectionProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const visibleGroups = groups.filter(g => g.rows.length > 0);
  if (steps.length === 0 && visibleGroups.length === 0 && !developer && !note) return null;
  return (
    <CollapsibleSection title="Manage" compact open={open} onToggle={onToggle} summary={summary}>
      <View style={styles.list}>
        {note ? <Text style={[t.hint, styles.note]}>{note}</Text> : null}
        {steps.map((s, i) => <StepView key={s.key} step={s} index={i} first={i === 0 && !note} />)}
        {visibleGroups.map((g, gi) => (
          <View key={g.key} style={(gi > 0 || steps.length > 0) && styles.groupGap}>
            {g.title ? (
              <Text style={[t.fieldLabel, styles.groupTitle]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {g.title}
              </Text>
            ) : null}
            {g.rows.map((r, i) => <ManageRow key={r.key} row={r} first={i === 0} />)}
          </View>
        ))}
        {developer ? (
          <View style={styles.groupGap}>
            <Text style={[t.fieldLabel, styles.groupTitle]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              Developer
            </Text>
            {developer}
          </View>
        ) : null}
      </View>
    </CollapsibleSection>
  );
}

/** Step number / check marker size; step content indents past it. */
const MARKER = 24;

const styles = StyleSheet.create({
  list: { marginVertical: -SPACE.xs },
  note: { paddingVertical: SPACE.xs },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  label: { flex: 1, minWidth: 0 },
  strong: { fontWeight: FONT.weight.bold },
  chevron: { fontSize: FONT.size.h2, fontWeight: FONT.weight.bold },
  dim: { opacity: 0.5 },
  step: { paddingVertical: SPACE.sm, gap: SPACE.xs },
  stepHead: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  marker: {
    width: MARKER, height: MARKER, borderRadius: RADIUS.pill, borderWidth: HAIRLINE,
    alignItems: 'center', justifyContent: 'center',
  },
  markerText: { fontSize: FONT.size.xs, fontWeight: FONT.weight.heavy },
  stepText: { flex: 1, minWidth: 0, gap: SPACE.xxs },
  // Content lines up under the label, past the 24 marker + gap.
  stepBody: { marginLeft: MARKER + SPACE.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  groupGap: { marginTop: SPACE.md },
  groupTitle: { paddingVertical: SPACE.xs },
});
