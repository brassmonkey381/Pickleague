// The decor sheet for one slot of my My Place, docked under the room so the
// room stays in view: my pickles, then what fits the slot (owned first, then
// for sale by price). Tap a row to preview it in the room; its button acts:
// Remove (in the slot now), Put in / Move here (owned), Buy (for sale; asks
// first, then puts it in), or says why not (not enough pickles, drop ended).
// Every refusal names why and what to do.
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon, EmojiGlyph } from '@just-messin-around/expo-foundation/icons';
import { RoomArt } from '@just-messin-around/expo-foundation/room';
import type { RoomArtResolver } from '@just-messin-around/expo-foundation/room/art';
import type { SlotDef } from '@just-messin-around/expo-foundation/room/layout';
import { limitedEndsLabel, rarityColors, rarityLabel } from '@just-messin-around/expo-foundation/room/shop';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { PickleAmount, PickleBalance, picklesLabel } from '../PickleAmount';
import type { DecorRow } from '../../lib/myPlace';

export type DecorNotice = { kind: 'success' | 'error' | 'info'; text: string };

type Props = {
  slot: SlotDef;
  rows: DecorRow[];
  balance: number | null;
  resolveArt: RoomArtResolver;
  previewId: string | null;
  onPreview: (row: DecorRow) => void;
  onAction: (row: DecorRow) => void;
  /** The item a write is running for (its button spins, the others wait). */
  busyId: string | null;
  notice: DecorNotice | null;
  onDismissNotice: () => void;
  /** The empty slot this one sits on (a pillow with no couch), or null. */
  blockedBy: SlotDef | null;
  blockedNote: string | null;
  onOpenSlot: (slotId: string) => void;
  slotLabel: (slotId: string) => string;
  onClose: () => void;
};

const THUMB = 52;

export default function DecorSheet({
  slot,
  rows,
  balance,
  resolveArt,
  previewId,
  onPreview,
  onAction,
  busyId,
  notice,
  onDismissNotice,
  blockedBy,
  blockedNote,
  onOpenSlot,
  slotLabel,
  onClose,
}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const busy = busyId != null;

  return (
    <View style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text style={t.h3} numberOfLines={1}>{slot.label}</Text>
          <View style={styles.balanceRow}>
            <Text style={t.meta} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>You have </Text>
            <PickleBalance balance={balance} preset="meta" />
          </View>
        </View>
        <TouchableOpacity
          onPress={onClose}
          style={styles.close}
          accessibilityRole="button"
          accessibilityLabel={`Close ${slot.label}`}
        >
          <Icon name="close" size={18} color={c.textSub} />
        </TouchableOpacity>
      </View>

      {blockedBy && blockedNote ? (
        <View style={[styles.notice, { backgroundColor: c.infoLight, borderColor: c.info }]}>
          <Text style={[t.sub, { color: c.text }]}>{blockedNote}</Text>
          <Button
            size="sm"
            variant="outline"
            title={`Open ${blockedBy.label}`}
            onPress={() => onOpenSlot(blockedBy.id)}
            style={styles.hug}
          />
        </View>
      ) : null}

      {notice ? (
        <TouchableOpacity
          onPress={onDismissNotice}
          accessibilityRole="alert"
          accessibilityHint="Tap to dismiss"
          style={[
            styles.notice,
            {
              backgroundColor: notice.kind === 'error' ? c.dangerLight : notice.kind === 'success' ? c.successLight : c.infoLight,
              borderColor: notice.kind === 'error' ? c.danger : notice.kind === 'success' ? c.success : c.info,
            },
          ]}
        >
          <Text style={[t.sub, { color: c.text }]}>{notice.text}</Text>
        </TouchableOpacity>
      ) : null}

      {rows.length === 0 ? (
        <Text style={[t.hint, styles.empty]}>
          Nothing fits {slot.label} yet. New decor arrives with each drop, so check back soon.
        </Text>
      ) : (
        rows.map((row, i) => {
          const { item, action } = row;
          const previewing = previewId === item.id;
          const tier = rarityColors(c, item.rarity);
          const tierText = rarityLabel(item.rarity);
          const ends = action.type === 'buy' || action.type === 'locked' ? limitedEndsLabel(item) : null;
          const thumbH = Math.min(THUMB, THUMB / Math.max(0.4, item.aspect ?? slot.aspect ?? 1));
          const thumbW = Math.min(THUMB, thumbH * (item.aspect ?? slot.aspect ?? 1));
          return (
            <View
              key={item.id}
              style={[
                styles.row,
                i > 0 && { borderTopWidth: HAIRLINE, borderTopColor: c.border },
                previewing && { backgroundColor: c.primaryLight },
              ]}
            >
              <TouchableOpacity
                style={styles.rowMain}
                onPress={() => onPreview(row)}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}. ${stateWords(row, slotLabel)}`}
                accessibilityHint="Shows it in your room"
                accessibilityState={{ selected: previewing }}
              >
                <View style={[styles.thumb, { backgroundColor: c.surfaceAlt, borderColor: tier ? tier.accent : c.border }]}>
                  {item.art || item.svg ? (
                    <RoomArt item={item} resolveArt={resolveArt} width={thumbW} height={thumbH} />
                  ) : (
                    <EmojiGlyph emoji={item.icon ?? '✨'} size={24} color={c.text} />
                  )}
                </View>
                <View style={styles.flex}>
                  <Text style={t.title} numberOfLines={1}>{item.name}</Text>
                  <View style={styles.tags}>
                    {tierText && tier ? (
                      <Text style={[t.badge, styles.tag, { color: tier.accent, backgroundColor: tier.tint }]}>{tierText}</Text>
                    ) : null}
                    <StateLine row={row} slotLabel={slotLabel} />
                  </View>
                  {ends ? <Text style={[t.caption, { color: c.warning }]} numberOfLines={1}>{ends}</Text> : null}
                </View>
              </TouchableOpacity>
              <ActionButton row={row} busy={busy} running={busyId === item.id} onPress={() => onAction(row)} slotLabel={slotLabel} />
            </View>
          );
        })
      )}
    </View>
  );
}

function StateLine({ row, slotLabel }: { row: DecorRow; slotLabel: (id: string) => string }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const a = row.action;
  switch (a.type) {
    case 'remove':
      return <Text style={[t.caption, { color: c.primary }]}>In your room</Text>;
    case 'equip':
      return <Text style={[t.caption, { color: c.textSub }]}>{a.from ? `Owned, in ${slotLabel(a.from)}` : 'Owned'}</Text>;
    case 'buy':
      return row.item.cost > 0 ? (
        <PickleAmount amount={row.item.cost} preset="caption" color={c.text} />
      ) : (
        <Text style={[t.caption, { color: c.success }]}>Free</Text>
      );
    case 'locked':
      return (
        <View style={styles.tags}>
          <PickleAmount amount={row.item.cost} preset="caption" color={c.textMuted} />
          <Text style={[t.caption, { color: c.textMuted }]}>
            {a.short != null ? ` Need ${a.short.toLocaleString()} more` : ' Balance loading'}
          </Text>
        </View>
      );
    case 'unavailable':
      return <Text style={[t.caption, { color: c.textMuted }]}>{a.notYet ? 'Not on sale yet' : 'No longer sold'}</Text>;
  }
}

function ActionButton({
  row,
  busy,
  running,
  onPress,
  slotLabel,
}: {
  row: DecorRow;
  busy: boolean;
  running: boolean;
  onPress: () => void;
  slotLabel: (id: string) => string;
}) {
  const a = row.action;
  const name = row.item.name;
  switch (a.type) {
    case 'remove':
      return (
        <Button size="sm" variant="outline" title="Remove" loading={running} disabled={busy} onPress={onPress}
          accessibilityLabel={`Remove ${name}`} style={styles.action} />
      );
    case 'equip':
      return (
        <Button size="sm" title={a.from ? 'Move here' : 'Put in'} loading={running} disabled={busy} onPress={onPress}
          accessibilityLabel={a.from ? `Move ${name} here from ${slotLabel(a.from)}` : `Put ${name} in your room`} style={styles.action} />
      );
    case 'buy':
      return (
        <Button size="sm" variant="success" title={row.item.cost > 0 ? 'Buy' : 'Get'} loading={running} disabled={busy} onPress={onPress}
          accessibilityLabel={row.item.cost > 0 ? `Buy ${name} for ${picklesLabel(row.item.cost)}` : `Get ${name} for free`} style={styles.action} />
      );
    case 'locked':
    case 'unavailable':
      // No dead button: the row's line says why, and a tap explains what to do.
      return (
        <Button size="sm" variant="outline" title="Why?" disabled={busy} onPress={onPress}
          accessibilityLabel={`Why can't I buy ${name}?`} style={styles.action} />
      );
  }
}

function stateWords(row: DecorRow, slotLabel: (id: string) => string): string {
  const a = row.action;
  switch (a.type) {
    case 'remove':
      return 'In your room';
    case 'equip':
      return a.from ? `Owned, in ${slotLabel(a.from)}` : 'Owned';
    case 'buy':
      return row.item.cost > 0 ? `For sale, ${picklesLabel(row.item.cost)}` : 'Free';
    case 'locked':
      return a.short != null ? `${picklesLabel(row.item.cost)}, you need ${a.short.toLocaleString()} more` : picklesLabel(row.item.cost);
    case 'unavailable':
      return a.notYet ? 'Not on sale yet' : 'No longer sold';
  }
}

const styles = StyleSheet.create({
  sheet: { borderWidth: HAIRLINE, borderRadius: RADIUS.lg, padding: SPACE.md, gap: SPACE.sm },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm },
  balanceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: -8, marginRight: -8 },
  flex: { flex: 1, minWidth: 0 },
  notice: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, gap: SPACE.xs },
  hug: { alignSelf: 'flex-start' },
  empty: { paddingVertical: SPACE.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm, borderRadius: RADIUS.md },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  thumb: { width: THUMB + 8, height: THUMB + 8, borderRadius: RADIUS.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tags: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  tag: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: RADIUS.sm, overflow: 'hidden' },
  action: { minWidth: 92 },
});
