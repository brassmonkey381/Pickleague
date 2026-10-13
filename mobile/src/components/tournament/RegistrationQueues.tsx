import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { TournamentRegistration } from '../../types';
import { formatPlupr } from '../../lib/plupr';
import FlairName from '../FlairName';
import { useTournamentDetailStyles } from './styles';
import type { TournamentDetailState } from './useTournamentDetail';

type QueueProps = Pick<TournamentDetailState, 'approveReg' | 'rejectReg'>;

/**
 * One queued registration: name, PLUPR, and approve / reject. Each button is a
 * 32px circle centred in its own 44x44 box (react-native-web ignores hitSlop).
 */
function QueueRow({ r, index, last, approveReg, rejectReg, approveLabel, rejectLabel }: {
  r: TournamentRegistration;
  index?: number;
  last: boolean;
  approveLabel: string;
  rejectLabel: string;
} & QueueProps) {
  const { S } = useTournamentDetailStyles();
  const name = r.profile?.full_name ?? 'Player';
  return (
    <View style={[S.row, last && S.rowLast]}>
      {index != null && <Text style={S.playerSeed}>#{index}</Text>}
      <FlairName
        name={name}
        nameColor={(r.profile as any)?.name_color}
        styleId={(r.profile as any)?.list_name_style_id ?? null}
        mode="list"
        style={S.playerName}
        numberOfLines={1}
      />
      <Text style={S.playerRating}>{formatPlupr((r.profile as any)?.rating, (r.profile as any)?.total_matches_played)}</Text>
      <View style={S.queueActions}>
        <TouchableOpacity
          style={S.queueBox}
          onPress={() => approveReg(r.id)}
          accessibilityRole="button"
          accessibilityLabel={`${approveLabel} ${name}`}
        >
          <View style={S.approveDot}><Text style={S.approveDotText}>✓</Text></View>
        </TouchableOpacity>
        <TouchableOpacity
          style={S.queueBox}
          onPress={() => rejectReg(r.id)}
          accessibilityRole="button"
          accessibilityLabel={`${rejectLabel} ${name}`}
        >
          <View style={S.rejectDot}><Text style={S.rejectDotText}>✕</Text></View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * Organizer: pending join requests with approve / reject. Rendered inline in
 * Manage's "Approve requests" step (P5b); the caller gates it on privilege.
 */
export function PendingRequestsSection({ pendingRequests, approveReg, rejectReg }:
  { pendingRequests: TournamentRegistration[] } & QueueProps) {
  return (
    <View>
      {pendingRequests.map((r, i) => (
        <QueueRow
          key={r.id}
          r={r}
          last={i === pendingRequests.length - 1}
          approveReg={approveReg}
          rejectReg={rejectReg}
          approveLabel="Approve"
          rejectLabel="Reject"
        />
      ))}
    </View>
  );
}

/**
 * Organizer: the waitlist, oldest first (players see their own position on
 * their You card). Rendered inline in Manage's "Approve requests" step.
 */
export function WaitlistSection({ waitlisted, approveReg, rejectReg }:
  { waitlisted: TournamentRegistration[] } & QueueProps) {
  const { S } = useTournamentDetailStyles();
  return (
    <View>
      <Text style={S.note}>
        Waitlist, oldest first: the order spots are offered when someone leaves or Max players is raised. Approving directly only works while a spot is free.
      </Text>
      {waitlisted.map((r, i) => (
        <QueueRow
          key={r.id}
          r={r}
          index={i + 1}
          last={i === waitlisted.length - 1}
          approveReg={approveReg}
          rejectReg={rejectReg}
          approveLabel="Approve from the waitlist:"
          rejectLabel="Remove from the waitlist:"
        />
      ))}
    </View>
  );
}
