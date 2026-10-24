// LeagueDetail's Manage section (plan section 5, slot 6): every privileged
// action on the screen, in one collapsed CollapsibleSection (controlled, so the
// screen can open it when a step is pending). Only admins, co-admins and the
// developer account (godmode delete) see it.
//
// Each action is one 44px row: label, optional meta on the right, chevron. A
// destructive row (godmode delete) is red and sits last.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { CollapsibleSection } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

export type LeagueManageRow = {
  key: string;
  label: string;
  /** Right-aligned meta ("3.50", "2 pending"). */
  meta?: string | null;
  onPress: () => void;
  danger?: boolean;
  /** Emphasised (a pending step, e.g. join requests waiting). */
  attention?: boolean;
};

export type LeagueManageSectionProps = {
  open: boolean;
  onToggle: (next: boolean) => void;
  /** One line under the title while collapsed. */
  summary?: string;
  rows: LeagueManageRow[];
  /** A non-actionable line above the rows (e.g. "This league is closed: edits are locked."). */
  note?: string | null;
};

export default function LeagueManageSection({ open, onToggle, summary, rows, note }: LeagueManageSectionProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  if (rows.length === 0 && !note) return null;
  return (
    <CollapsibleSection
      title="Manage"
      compact
      open={open}
      onToggle={onToggle}
      summary={summary}
    >
      {/* The section body pads 12 and gaps 8; rows bring their own dividers instead. */}
      <View style={styles.list}>
        {note ? <Text style={[t.hint, styles.note]}>{note}</Text> : null}
        {rows.map((r, i) => (
          <TouchableOpacity
            key={r.key}
            onPress={r.onPress}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={r.meta ? `${r.label}, ${r.meta}` : r.label}
            style={[styles.row, i > 0 && { borderTopWidth: HAIRLINE, borderTopColor: c.border }]}
          >
            <Text
              style={[
                t.sub,
                styles.label,
                { color: r.danger ? c.danger : c.text },
                (r.attention || r.danger) && styles.strong,
              ]}
              numberOfLines={1}
            >
              {r.label}
            </Text>
            {r.meta ? (
              <Text
                style={[t.meta, r.attention && { color: c.primary }]}
                numberOfLines={1}
                maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
              >
                {r.meta}
              </Text>
            ) : null}
            <Icon name="chevron-right" size={16} color={r.danger ? c.danger : c.textMuted} />
          </TouchableOpacity>
        ))}
      </View>
    </CollapsibleSection>
  );
}

const styles = StyleSheet.create({
  list: { marginVertical: -SPACE.xs },
  note: { paddingVertical: SPACE.xs },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  label: { flex: 1, minWidth: 0 },
  strong: { fontWeight: FONT.weight.bold },
});
