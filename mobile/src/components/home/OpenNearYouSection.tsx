// OPEN NEAR YOU / OPEN LEAGUES (plan section 3): for a league member, up to 3
// open tournaments or joinable leagues that aren't already in YOURS. Titled
// "Open near you" (nearest first, with distance) only when location is ALREADY
// granted; otherwise "Open leagues". Home never asks for location to fill it.
// Plain navigation rows: inline Join lives only in JOIN A LEAGUE (decision 1).
// Capped at 3, so when more were found the header says "See all (N) >" (section
// 6 rule 4: a capped list never cuts silently), opening Play's Discover. N is
// dropped ("See all >") when the fetch itself hit a row limit and N is a floor.
import React from 'react';
import { View } from 'react-native';
import { Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import LeagueRow from '../LeagueRow';
import TournamentRow from '../TournamentRow';
import { dayLabel, shortTime } from '../../lib/agenda';
import type { HomeOpenLeague, HomeOpenTournament } from './homeData';

export type OpenItem =
  | { kind: 'league'; key: string; league: HomeOpenLeague; distance: string | null }
  | { kind: 'tournament'; key: string; tournament: HomeOpenTournament; distance: string | null };

type Props = {
  items: OpenItem[];
  nearby: boolean;
  now: number;
  onPress: (item: OpenItem, position: number) => void;
  /** Everything found before the 3-row cap. */
  total: number;
  /** The fetch hit a row limit: `total` is a floor, so don't print it. */
  totalIsFloor?: boolean;
  onSeeAll: () => void;
};

export default function OpenNearYouSection({ items, nearby, now, onPress, total, totalIsFloor, onSeeAll }: Props) {
  if (items.length === 0) return null;
  const cut = total > items.length;
  return (
    <View>
      <SectionHeader
        title={nearby ? 'Open near you' : 'Open leagues'}
        action={cut ? {
          label: totalIsFloor ? 'See all' : `See all (${total})`,
          chevron: true,
          a11yLabel: totalIsFloor ? 'See all open leagues and tournaments' : `See all ${total} open leagues and tournaments`,
          onPress: onSeeAll,
        } : undefined}
      />
      <Panel padded={false}>
        {items.map((item, i) => {
          const last = i === items.length - 1;
          if (item.kind === 'league') {
            return (
              <LeagueRow
                key={item.key}
                layout="row"
                league={item.league}
                role={null}
                requested={item.league.requested}
                memberCount={item.league.memberCount}
                facts={[item.distance, item.league.inSeason && 'In season']}
                lastRow={last}
                onPress={() => onPress(item, i)}
              />
            );
          }
          const tr = item.tournament;
          const start = tr.start_time ? new Date(tr.start_time) : null;
          const when = start && !Number.isNaN(start.getTime())
            ? `${dayLabel(start, new Date(now))} ${shortTime(start)}`
            : null;
          return (
            <TournamentRow
              key={item.key}
              layout="row"
              tournament={{ id: tr.id, name: tr.name, location_name: tr.location_name, status: 'registration' }}
              leagueName={tr.leagueName}
              facts={[item.distance, tr.formatLabel]}
              showStatus
              trailingText={when}
              lastRow={last}
              onPress={() => onPress(item, i)}
            />
          );
        })}
      </Panel>
    </View>
  );
}
