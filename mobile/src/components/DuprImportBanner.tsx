import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { ListCard } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';

type Match = {
  dupr_id: string | null;
  club_name: string | null;
  full_name: string | null;
  singles: number | null;
  doubles: number | null;
  /** Set when the roster row is held by an unclaimed placeholder we'd absorb. */
  placeholder_profile: string | null;
};

type ClaimResult = {
  ok: boolean;
  reason?: string;
  rating?: number | null;
  /** False when the player already had match history — link only, rating kept. */
  rating_applied?: boolean;
  absorbed_placeholder?: boolean;
  placeholder_kept?: boolean;
};

/**
 * Why a claim came back not-ok, in the player's words. Every one of these is
 * terminal — the banner stops offering rather than silently retrying forever.
 */
function refusalMessage(reason: string | undefined): string {
  switch (reason) {
    case 'already_claimed':
      return 'That DUPR profile is already linked to another Pickleague account.';
    case 'email_not_confirmed':
      return 'Confirm your email address first, then we can link your DUPR profile.';
    case 'no_match':
      return 'We could not find your DUPR profile any more — it may have been re-synced.';
    default:
      return 'We could not link your DUPR profile. Try again later.';
  }
}

/**
 * "We found your DUPR rating — import it?" offer.
 *
 * Shown only when the signed-in user's CONFIRMED email appears on an imported
 * DUPR club roster (see public.my_dupr_match). Everything is opt-in: we never
 * mail anyone, and nothing is written until the player taps Import.
 *
 * The RPC is scoped server-side to the caller's own confirmed address and
 * returns name/club/ratings only — never contact details — so there is nothing
 * sensitive to render here.
 *
 * Both answers are PERSISTED (profiles.dupr_import_dismissed_at, filtered by
 * my_dupr_match). Hiding in component state alone meant the banner returned on
 * every reload, which is exactly what it did in production: an account with match
 * history could never claim, and the refusal was swallowed silently.
 *
 * Split into a hook + a row so Home's Get started panel can count the offer as
 * one of its rows (plan section 3: never a separate banner). The hook keeps the
 * outcome line ("PLUPR set to 4.12" / why it couldn't link) after the offer
 * goes, so the player sees what happened.
 */
export type DuprImportOffer = {
  match: Match | null;
  busy: boolean;
  /** Success copy after Import. */
  done: string | null;
  /** Why the link was refused (terminal). */
  failed: string | null;
  /** Anything to render: the offer, or its outcome. */
  visible: boolean;
  onImport: () => Promise<void>;
  onDismiss: () => Promise<void>;
};

export function useDuprImportOffer(): DuprImportOffer {
  const [match, setMatch] = useState<Match | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Same auth-lock hazard as GuestUpgradeBanner: never call a supabase.auth
    // method inside onAuthStateChange — it deadlocks. `supabase.rpc` is
    // lock-free, but we still defer with setTimeout to stay off the lock.
    async function check(userId: string | undefined) {
      if (!userId) { if (!cancelled) setMatch(null); return; }
      const { data, error } = await supabase.rpc('my_dupr_match');
      if (cancelled || error) return;
      const row: Match | undefined = Array.isArray(data) ? data[0] : data;
      // Only offer it when there is actually a rating to carry over.
      setMatch(row && (row.doubles != null || row.singles != null) ? row : null);
    }

    supabase.auth.getSession().then(({ data: { session } }) => check(session?.user?.id));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      const id = session?.user?.id;
      setTimeout(() => check(id), 0);
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  const onImport = useCallback(async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('import_my_dupr_rating');
    setBusy(false);
    if (error) {
      setFailed('Something went wrong linking your DUPR profile. Try again later.');
      return;
    }
    const result = data as ClaimResult | null;
    if (result?.ok) {
      // Linking always happens; the rating is only ever a SEED for an account
      // with no matches yet, so say which one the player actually got.
      setDone(
        result.rating_applied
          ? `PLUPR set to ${Number(result.rating).toFixed(2)}`
          : 'DUPR profile linked. Your PLUPR is unchanged — it is earned from matches you have played here.',
      );
      setMatch(null);
      return;
    }
    // Every refusal is terminal. Say why and record the dismissal, or the banner
    // returns on the next reload and the player is stuck in a loop.
    setFailed(refusalMessage(result?.reason));
    setMatch(null);
    void supabase.rpc('dismiss_dupr_import');
  }, []);

  const onDismiss = useCallback(async () => {
    setMatch(null);
    // Persisted server-side — component state alone does not survive a reload.
    await supabase.rpc('dismiss_dupr_import');
  }, []);

  return { match, busy, done, failed, visible: !!(match || done || failed), onImport, onDismiss };
}

type RowProps = {
  offer: DuprImportOffer;
  /** The Panel's final row (no divider under it). */
  lastRow?: boolean;
  /** Analytics hook for the two buttons. */
  onPressed?: (target: 'dupr_import' | 'dupr_dismiss') => void;
};

/** The leading glyph column, as wide as the starter quests' marks and EntityRow's tile. */
function Lead({ name, color }: { name: IconName; color: string }) {
  return (
    <View style={styles.lead}>
      <Icon name={name} size={18} color={color} />
    </View>
  );
}

/** The offer (or its outcome) as a Get started row inside a <Panel padded={false}>. */
export function DuprImportRow({ offer, lastRow, onPressed }: RowProps) {
  const { colors: c } = useTheme();
  if (offer.done) {
    return (
      <ListCard
        variant="row"
        lastRow={lastRow}
        leading={<Lead name="check" color={c.success} />}
        title="DUPR profile linked"
        subtitle={offer.done}
        subtitleLines={2}
      />
    );
  }
  if (offer.failed) {
    return (
      <ListCard
        variant="row"
        lastRow={lastRow}
        leading={<Lead name="info" color={c.textMuted} />}
        title="DUPR link unavailable"
        subtitle={offer.failed}
        subtitleLines={2}
      />
    );
  }
  const match = offer.match;
  if (!match) return null;
  const rating = match.doubles ?? match.singles;
  return (
    <ListCard
      variant="row"
      lastRow={lastRow}
      leading={<Lead name="pickleball" color={c.primary} />}
      title="We found your DUPR rating"
      subtitle={`${Number(rating).toFixed(2)} doubles${match.club_name ? ` · ${match.club_name}` : ''}. Start your PLUPR here?`}
      subtitleLines={2}
    >
      <View style={styles.actions}>
        <Button
          size="sm"
          title="Import"
          loading={offer.busy}
          disabled={offer.busy}
          onPress={() => { onPressed?.('dupr_import'); void offer.onImport(); }}
        />
        <Button
          size="sm"
          variant="outline"
          title="Not me"
          disabled={offer.busy}
          onPress={() => { onPressed?.('dupr_dismiss'); void offer.onDismiss(); }}
        />
      </View>
    </ListCard>
  );
}

/** Self-contained variant: the hook and the row together. */
export default function DuprImportBanner({ lastRow }: { lastRow?: boolean }) {
  const offer = useDuprImportOffer();
  if (!offer.visible) return null;
  return <DuprImportRow offer={offer} lastRow={lastRow} />;
}

const styles = StyleSheet.create({
  // sm buttons hug their labels (style targets the 44 box).
  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, alignSelf: 'flex-start' },
  // 32 wide: the same column as EntityRow's tile, so every Get started title lines up.
  lead: { width: 32, alignItems: 'center' },
});
