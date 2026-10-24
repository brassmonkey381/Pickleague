import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

// TournamentDetail's shared stylesheet. P5a moved it out of the screen
// verbatim; P5b swept it onto the compaction system (plan section 6): every
// spacing and radius is a SPACE / RADIUS token, every colour a theme colour,
// every font size on the FONT scale (no 16 / 18 / 22), no shadows (only
// overlays may have one), and minHeight (never height) on rows, with 44px
// boxes on everything tappable. The section chrome itself now comes from the
// foundation (Panel, CollapsibleSection, SectionHeader); what is left here is
// the inside of the sections that the extracted components still share.
export function makeTournamentDetailStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },

    // ── Rows inside a section (hairline-divided, 44 min) ──
    row: {
      minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
      paddingVertical: SPACE.xs, borderBottomWidth: HAIRLINE, borderBottomColor: c.border,
    },
    rowLast: { borderBottomWidth: 0 },
    playerSeed: { width: 24, fontSize: FONT.size.sm, color: c.textMuted, fontWeight: FONT.weight.semibold },
    playerName: { flex: 1, fontSize: FONT.size.md, fontWeight: FONT.weight.semibold, color: c.text },
    playerRating: { fontSize: FONT.size.base, fontWeight: FONT.weight.bold, color: c.primary },
    note: { fontSize: FONT.size.sm, color: c.textMuted, lineHeight: FONT.line.tight },

    // ── Approve / reject: a 32 circle centred in a real 44 box ──
    queueActions: { flexDirection: 'row' },
    queueBox: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    approveDot: { width: 32, height: 32, borderRadius: RADIUS.pill, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
    rejectDot: { width: 32, height: 32, borderRadius: RADIUS.pill, backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },

    // ── Pools & bracket ──
    poolsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
    poolBlock: { flexGrow: 1, flexBasis: 140, backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, padding: SPACE.md, borderWidth: HAIRLINE, borderColor: c.border },
    poolLabel: { fontSize: FONT.size.sm, fontWeight: FONT.weight.heavy, color: c.info, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: SPACE.xs },
    poolPlayer: { fontSize: FONT.size.base, color: c.textSub, paddingVertical: SPACE.xxs },
    bracketDivider: { height: HAIRLINE, backgroundColor: c.border, marginVertical: SPACE.md },
    advancementCard: { backgroundColor: c.infoLight, borderRadius: RADIUS.md, padding: SPACE.md, borderWidth: HAIRLINE, borderColor: c.info },
    advancementTitle: { fontSize: FONT.size.base, fontWeight: FONT.weight.bold, color: c.info, marginBottom: SPACE.xs },
    advancementRule: { fontSize: FONT.size.base, color: c.text, lineHeight: FONT.line.tight, marginBottom: SPACE.xs },
    advancementPoint: { fontSize: FONT.size.base, color: c.textSub, lineHeight: FONT.line.tight, paddingLeft: SPACE.sm },
    advancementResultLine: { fontSize: FONT.size.sm, color: c.primary, fontWeight: FONT.weight.semibold, marginTop: SPACE.sm, paddingTop: SPACE.sm, borderTopWidth: HAIRLINE, borderTopColor: c.border },
    bold: { fontWeight: FONT.weight.bold },

    // ── Match rows (schedule + preview) ──
    roundBlock: { marginTop: SPACE.sm },
    roundLabel: { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, paddingVertical: SPACE.xs },
    matchRow: {
      minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
      paddingVertical: SPACE.xs, paddingHorizontal: SPACE.xs,
      borderBottomWidth: HAIRLINE, borderBottomColor: c.border,
    },
    matchRowHighlight: { backgroundColor: c.primaryLight, borderRadius: RADIUS.sm },
    matchNum: { width: 20, fontSize: FONT.size.xs, color: c.textMuted, fontWeight: FONT.weight.semibold },
    matchup: { flex: 1, fontSize: FONT.size.base, fontWeight: FONT.weight.semibold, color: c.text },
    matchupHighlight: { color: c.primary, fontWeight: FONT.weight.heavy },
    matchupWinner: { fontWeight: FONT.weight.heavy, color: c.text },
    matchupLoser: { color: c.textMuted },
    matchScore: { fontSize: FONT.size.base, fontWeight: FONT.weight.heavy, color: c.textSub, paddingHorizontal: SPACE.xs },
    vs: { fontSize: FONT.size.xs, color: c.textMuted, fontWeight: FONT.weight.bold },
    youTag: { fontSize: FONT.size.xxs, fontWeight: FONT.weight.heavy, color: c.primary, backgroundColor: c.primaryLight, paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xxs, borderRadius: RADIUS.sm, overflow: 'hidden' },
    previewBanner: { backgroundColor: c.warningLight, borderRadius: RADIUS.sm, padding: SPACE.sm, marginBottom: SPACE.sm },
    previewBannerText: { fontSize: FONT.size.sm, color: c.warning, fontWeight: FONT.weight.semibold },

    // ── Wager market table ──
    wagerMarketHeader: {
      flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACE.xs, paddingBottom: SPACE.xs,
      borderBottomWidth: HAIRLINE, borderBottomColor: c.border,
    },
    wagerMarketCellLabel: {
      width: 64, fontSize: FONT.size.xs, fontWeight: FONT.weight.heavy, color: c.textMuted,
      textTransform: 'uppercase', letterSpacing: 0.6, textAlign: 'center',
    },
    wagerMarketRow: {
      minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACE.xs, gap: SPACE.xs,
      borderBottomWidth: HAIRLINE, borderBottomColor: c.border,
    },
    wagerMarketPlayerCell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minWidth: 0 },
    wagerMarketAvatar: { width: 28, height: 28, borderRadius: RADIUS.pill, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center' },
    wagerMarketAvatarText: { fontSize: FONT.size.base, fontWeight: FONT.weight.heavy, color: c.primary },
    wagerMarketName: { flex: 1, fontSize: FONT.size.base, fontWeight: FONT.weight.semibold, color: c.text },
    // A 28 pill inside a real 44 box (react-native-web ignores hitSlop).
    wagerMarketBetBox: { width: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    wagerMarketBetPill: {
      paddingVertical: SPACE.xs, paddingHorizontal: SPACE.sm, borderRadius: RADIUS.pill, borderWidth: HAIRLINE,
      borderColor: c.primary, backgroundColor: c.primaryLight,
    },
    wagerMarketBetText: { fontSize: FONT.size.xs, fontWeight: FONT.weight.heavy, color: c.primary },
    wagerMarketToggle: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    wagerMarketToggleText: { fontSize: FONT.size.sm, fontWeight: FONT.weight.bold, color: c.primary },
    pressed: { opacity: 0.7 },

    // ── Edit Tournament page sheet ──
    // Sheet padding is SPACE.xl; EditTournamentModal adds the status-bar inset
    // on Android (edge-to-edge draws the Modal under it) instead of a fixed 48.
    editModal: { padding: SPACE.xl, flexGrow: 1, backgroundColor: c.surface },
    editModalTitle: { fontSize: FONT.size.h2, fontWeight: FONT.weight.heavy, color: c.text, marginBottom: SPACE.xs },
    editFieldLabel: { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: SPACE.lg, marginBottom: SPACE.xs },
    editInput: { minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg, marginBottom: SPACE.xs, backgroundColor: c.surface, color: c.text },
    editInputMultiline: { minHeight: 96, textAlignVertical: 'top' },
    editDateText: { fontSize: FONT.size.lg, color: c.text },
    editDatePlaceholder: { fontSize: FONT.size.lg, color: c.textMuted },
    editSaveBtn: { minHeight: 50, backgroundColor: c.primary, paddingHorizontal: SPACE.lg, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', marginTop: SPACE.xl },
    editSaveBtnDisabled: { opacity: 0.5 },
    editSaveBtnText: { color: c.textInverse, fontWeight: FONT.weight.bold, fontSize: FONT.size.lg },
    editCancelBtn: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    editCancelBtnText: { fontSize: FONT.size.lg, color: c.textMuted },
    editErrorText: { marginTop: SPACE.lg, color: c.danger, fontSize: FONT.size.md, fontWeight: FONT.weight.semibold },
    editInlineAction: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    editInlineActionText: { fontSize: FONT.size.sm, color: c.primary, fontWeight: FONT.weight.bold },
    editInlineDanger: { fontSize: FONT.size.base, color: c.danger, fontWeight: FONT.weight.semibold },

    // ── Exact-score modal inputs ──
    scoreRow: { flexDirection: 'row', gap: SPACE.md, marginTop: SPACE.xs, marginBottom: SPACE.sm },
    scoreLabel: { fontSize: FONT.size.sm, fontWeight: FONT.weight.bold, color: c.textMuted, marginBottom: SPACE.xs },
    scoreInput: {
      minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md,
      paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg, color: c.text,
      backgroundColor: c.surface,
    },
  });
}

export type TournamentDetailStyles = ReturnType<typeof makeTournamentDetailStyles>;

/**
 * The shared stylesheet plus the theme colours, for the extracted sections.
 * Memoized on the colour set so each section doesn't rebuild the sheet on
 * every parent render.
 */
export function useTournamentDetailStyles() {
  const { colors: c } = useTheme();
  const S = useMemo(() => makeTournamentDetailStyles(c), [c]);
  return { S, c };
}
