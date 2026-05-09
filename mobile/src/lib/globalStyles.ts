import { StyleSheet, Platform } from 'react-native';
import { Theme } from './theme';

export function gs(c: Theme) {
  return StyleSheet.create({
    // ── Layout ──────────────────────────────
    screen:    { flex: 1, backgroundColor: c.bg },
    scrollPad: { padding: 16, paddingBottom: 40, backgroundColor: c.bg },
    center:    { alignItems: 'center', justifyContent: 'center' },

    // ── Cards ───────────────────────────────
    card: {
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 16,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOpacity: 0.07,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },
    cardBorderLeft: {
      backgroundColor: c.surface,
      borderRadius: 14,
      padding: 14,
      marginBottom: 10,
      borderLeftWidth: 4,
      borderLeftColor: c.border,
      shadowColor: '#000',
      shadowOpacity: 0.05,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 1 },
      elevation: 2,
    },

    // ── Typography ───────────────────────────
    h1:      { fontSize: 26, fontWeight: '800', color: c.text },
    h2:      { fontSize: 20, fontWeight: '700', color: c.text },
    h3:      { fontSize: 16, fontWeight: '600', color: c.text },
    body:    { fontSize: 15, color: c.text, lineHeight: 22 },
    sub:     { fontSize: 13, color: c.textSub },
    muted:   { fontSize: 12, color: c.textMuted },
    label:   {
      fontSize: 11,
      fontWeight: '700',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },

    // ── Buttons ─────────────────────────────
    btn: {
      backgroundColor: c.primary,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 20,
      alignItems: 'center',
    },
    btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

    btnOutline: {
      borderWidth: 1.5,
      borderColor: c.primary,
      borderRadius: 12,
      paddingVertical: 13,
      paddingHorizontal: 20,
      alignItems: 'center',
    },
    btnOutlineText: { color: c.primary, fontSize: 16, fontWeight: '700' },

    btnDanger: {
      backgroundColor: c.danger,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
    },

    // ── Inputs ──────────────────────────────
    input: {
      borderWidth: 1.5,
      borderColor: c.border,
      borderRadius: 12,
      paddingVertical: Platform.OS === 'ios' ? 14 : 11,
      paddingHorizontal: 14,
      fontSize: 15,
      color: c.text,
      backgroundColor: c.surface,
    },

    // ── Pills / Chips ────────────────────────
    pill: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 20,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.surfaceAlt,
    },
    pillActive: {
      borderColor: c.primary,
      backgroundColor: c.primaryLight,
    },
    pillText:       { fontSize: 13, color: c.textSub, fontWeight: '500' },
    pillTextActive: { fontSize: 13, color: c.primary, fontWeight: '700' },

    // ── Rows / Dividers ──────────────────────
    row:     { flexDirection: 'row', alignItems: 'center' },
    divider: { height: 1, backgroundColor: c.border, marginVertical: 4 },

    // ── Section header ───────────────────────
    sectionHeader: {
      fontSize: 11,
      fontWeight: '700',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.9,
      marginTop: 20,
      marginBottom: 8,
    },

    // ── Empty state ──────────────────────────
    empty: {
      textAlign: 'center',
      color: c.textMuted,
      fontSize: 15,
      marginTop: 60,
      lineHeight: 22,
    },

    // ── Filter bar ───────────────────────────
    filterBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: 8,
    },
    filterPanel: {
      backgroundColor: c.surface,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: 8,
    },

    // ── Badge (notification dot) ─────────────
    badge: {
      position: 'absolute',
      top: 4,
      right: 2,
      backgroundColor: '#c62828',
      borderRadius: 9,
      minWidth: 18,
      height: 18,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 3,
    },
    badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  });
}
