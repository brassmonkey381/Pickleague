// A tournament as one compact row (plan section 4 "Play > Tournaments", section
// 6 Compact/Row). Used by Play Mine / Open for registration / In progress,
// Home YOURS, and Profile "Coming up". Presentational: the caller fetches,
// picks the chips and the trailing time, and navigates.
//
//   [🏆] Fall Open  (Invited)                     Sat 9 AM  ›
//        Lake Merritt · The League · Doubles RR
//   [🏆] Oakland Classic                          [ Register ]
//
// The subtitle names the COURT via displayCourtName (never a city), then the
// league, then the caller's facts. Empty facts drop out, so a tournament with
// no location never shows "TBD" or "Unknown" (content rule 3).
import React, { type ReactNode } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { useCourtName } from '../lib/courtNickname';
import { joinFacts, myRegistrationChip, tournamentStatusChip } from '../lib/entityGlyph';
import EntityRow, { type EntityRowChip, type EntityRowLayout } from './EntityRow';

export type TournamentRowTournament = {
  id: string;
  name: string;
  location_name?: string | null;
  /** tournaments.status: 'registration' | 'active' | 'completed' | 'cancelled'. */
  status?: string | null;
};

export type TournamentRowProps = {
  tournament: TournamentRowTournament;
  /** Default 'compact' (full-screen lists); 'row' inside a <Panel padded={false}>. */
  layout?: EntityRowLayout;
  /** The league it belongs to (subtitle). */
  leagueName?: string | null;
  /** Extra subtitle facts after court and league ("Doubles RR", "4 spots left"). */
  facts?: ReadonlyArray<string | null | undefined | false>;
  /** Replaces the whole built subtitle. '' = no subtitle. */
  subtitle?: string | null;
  /** Default true. false drops the court from the built subtitle. */
  showCourt?: boolean;
  /** The viewer's registration (tournament_registrations.status) -> first chip
   *  (Invited / Requested / Registered / Waitlist). */
  myStatus?: 'pending' | 'approved' | 'rejected' | 'waitlisted' | string | null;
  /** The pending registration is an invite (invited_by set): "Invited". */
  invited?: boolean;
  /** Show the lifecycle chip (Open / In progress / Ended / Cancelled). Default
   *  false: a list already grouped by status doesn't need it on every row. */
  showStatus?: boolean;
  /** Extra chips. Only 2 chips render in total. */
  chips?: ReadonlyArray<EntityRowChip | null | undefined | false>;
  /** The one trailing badge, usually the start ("Sat 9 AM", "Nov 2"). Hidden when `action` is set. */
  trailingText?: string | null;
  /** Trailing action, e.g. <Button size="sm" title="Register" />. Replaces the chevron. */
  action?: ReactNode;
  onPress?: () => void;
  lastRow?: boolean;
  highlighted?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function TournamentRow({
  tournament,
  layout = 'compact',
  leagueName,
  facts,
  subtitle,
  showCourt = true,
  myStatus,
  invited,
  showStatus = false,
  chips,
  trailingText,
  action,
  onPress,
  lastRow,
  highlighted,
  style,
}: TournamentRowProps) {
  // Subscribes to the court-nickname cache so the row re-renders when it loads.
  const courtName = useCourtName();

  const builtSubtitle = subtitle !== undefined
    ? subtitle
    : joinFacts([
        showCourt && courtName(tournament.location_name),
        leagueName,
        ...(facts ?? []),
      ]);

  return (
    <EntityRow
      kind="tournament"
      layout={layout}
      title={tournament.name}
      subtitle={builtSubtitle}
      chips={[
        myRegistrationChip(myStatus, invited),
        showStatus && tournamentStatusChip(tournament.status),
        ...(chips ?? []),
      ]}
      trailingText={trailingText}
      action={action}
      onPress={onPress}
      lastRow={lastRow}
      highlighted={highlighted}
      style={style}
    />
  );
}
