// One court in one day of the Pickleague Feed: the feed's top layer (Doggle's
// FeedParkCard, with the player's avatar and PLUPR where Doggle shows the
// dog). The header is the court (a star glyph for a starred court, a pin
// otherwise; tap opens its page) and, as on Doggle's park card, one
// "Check in ▾" (lib/checkinOptions): today [On my way ▾] while a friend is
// here (or "On the way" once told) and [Check in ▾], nothing once I'm
// checked in here (my own line has it); tomorrow [Plan ▾]. The crowd line
// sits under it. Its lines run in time order: friends who came and went
// today (faded), me and friends here now (with their play mode), then what
// is coming there (league events, booked matches, tournaments, drills, votes,
// my routine stops, my one-off planned check-ins). Each person / stop / plan
// line's time chip opens what I can do
// with it; a league line opens its screen. Over 6 lines the oldest finished
// visits give way first.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Avatar, type ChipTone } from '@just-messin-around/expo-foundation/ui';
import { FeedTimeChip } from '@just-messin-around/expo-foundation/ui/feed';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../../lib/ThemeContext';
import { dayLabel, shortTime } from '../../lib/agenda';
import { crowdLineText } from '../../lib/courtCrowd';
import { formatPluprShort } from '../../lib/plupr';
import { playerModeLine, playModeNowLine, type PlayModeRow } from '../../lib/courtRoutineRules';
import { courtHeaderActions, lineIsPast, sheetLineFacts } from '../../lib/checkinOptions';
import { capCourtLines, type DayBandKey, type FeedCourtCard as Card, type FeedCourtLine, type FeedSheetLine } from '../../lib/pickleagueFeed';
import FeedHeaderAction from './FeedHeaderAction';

const AVATAR = 36;

export type FeedCourtCardActions = {
  openCourt: (card: Card) => void;
  /** Today's "Check in ▾": the court's options sheet. */
  checkInOptions: (card: Card) => void;
  /** Tomorrow's "Plan ▾". */
  plan: (card: Card) => void;
  /** Today's "On my way ▾": the sheet that tells friends I'm heading there. */
  onMyWay: (card: Card) => void;
  /** What the header can offer: friends to tell, told them in the last 30
   *  minutes from this device, anything to plan tomorrow. */
  headerFacts: (card: Card) => { canOnMyWay: boolean; onMyWaySent: boolean; canPlan: boolean };
  /** A header action is running ("…") / something else is (dimmed). */
  headerState: (card: Card, action: 'checkIn' | 'onMyWay' | 'plan') => { busy: boolean; disabled: boolean };
  /** A league-side line (event, match, tournament, drill, vote) on this card. */
  renderAgenda: (line: Extract<FeedCourtLine, { kind: 'agenda' }>, card: Card, day: DayBandKey) => React.ReactNode;
  /** A line's time chip: its action sheet. */
  openLine: (line: FeedSheetLine, card: Card, day: DayBandKey) => void;
  openPerson: (userId: string, name: string) => void;
  /** This line's action is running / another one is. */
  lineState: (key: string) => { busy: boolean; disabled: boolean };
};

const clock = (iso: string) => shortTime(new Date(iso));

export default function FeedCourtCard({
  card,
  day,
  now,
  modes,
  openNow,
  plupr,
  friendsFailed,
  actions,
}: {
  card: Card;
  day: DayBandKey;
  now: number;
  /** court_play_modes by user id (today, courts with people here). */
  modes: ReadonlyMap<string, PlayModeRow> | null;
  /** How many there are open to play now (court_play_modes), when known. */
  openNow: number | null;
  /** Friends' doubles PLUPR by user id (the friends list). */
  plupr: ReadonlyMap<string, number | null>;
  /** The friends-at-courts read failed with nothing cached: an empty card says so. */
  friendsFailed?: boolean;
  actions: FeedCourtCardActions;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [all, setAll] = React.useState(false);
  const capped = capCourtLines(card.lines);
  // "Later this week" spans several days: a stop there names its day ("Sat 6 PM").
  const stopClock = (iso: string) => (day === 'later' ? `${dayLabel(new Date(iso), new Date(now))} ${clock(iso)}` : clock(iso));
  const shown = all ? card.lines : capped.shown;
  const more = all ? 0 : capped.more;

  const crowd =
    day !== 'today'
      ? null
      : crowdLineText(card.crowd, null, { openNow, showFriends: false }) ??
        (card.othersHere > 0 ? `+${card.othersHere} other${card.othersHere === 1 ? '' : 's'} here` : null);

  function chip(l: FeedSheetLine): { label: string; tone: ChipTone } {
    if (l.kind === 'mine' || l.kind === 'here') return { label: l.kind === 'here' && l.viaSession ? 'Playing now' : 'Here now', tone: 'success' };
    if (l.kind === 'left') return { label: 'Left', tone: 'neutral' };
    if (l.kind === 'plan') {
      return { label: `At ${stopClock(l.plan.at)}`, tone: Date.parse(l.plan.at) <= now ? 'neutral' : 'warning' };
    }
    if (l.stop.status === 'cancelled') return { label: 'Skipped', tone: 'neutral' };
    const started = Date.parse(l.stop.at) <= now;
    return { label: `At ${stopClock(l.stop.at)}`, tone: started ? 'neutral' : 'warning' };
  }

  function trailing(l: FeedSheetLine, who: string) {
    const ch = chip(l);
    const { busy, disabled } = actions.lineState(l.key);
    return (
      <FeedTimeChip
        label={ch.label}
        tone={ch.tone}
        busy={busy}
        disabled={disabled}
        onPress={() => actions.openLine(l, card, day)}
        a11y={`${ch.label}, ${who} at ${card.venueName}. Options`}
      />
    );
  }

  function personLine(l: Extract<FeedCourtLine, { kind: 'here' | 'left' }>) {
    const p = l.person;
    const rating = plupr.get(p.userId);
    const mode = l.kind === 'here' ? modes?.get(p.userId) : undefined;
    const facts = [
      rating != null ? `PLUPR ${formatPluprShort(rating, null)}` : null,
      l.kind === 'left'
        ? `${clock(l.at)}–${clock(l.endedAt)}`
        : (mode ? playerModeLine(mode) : '') || (l.until ? `until ${clock(l.until)}` : `since ${clock(l.at)}`),
    ].filter(Boolean);
    return (
      <View style={styles.line}>
        <Avatar
          size={AVATAR}
          photoUrl={p.avatarUrl}
          name={p.name}
          icon={p.avatarEmoji && !p.avatarUrl ? <Text style={styles.emoji}>{p.avatarEmoji}</Text> : undefined}
          backgroundColor={p.avatarBgColor ?? undefined}
        />
        <View style={styles.body}>
          <View style={styles.nameRow}>
            <Text
              style={[t.title, styles.shrink]}
              numberOfLines={1}
              onPress={() => actions.openPerson(p.userId, p.name)}
              accessibilityRole="link"
            >
              {p.name}
            </Text>
            {p.isCloseFriend ? <Icon name="star" size={12} color={c.primary} accessibilityLabel="Close friend" /> : null}
          </View>
          {facts.length ? (
            <Text style={[t.meta, { color: l.kind === 'here' ? c.success : c.textSub }]} numberOfLines={1}>
              {facts.join(' · ')}
            </Text>
          ) : null}
        </View>
        {trailing(l, p.name)}
      </View>
    );
  }

  /** My own check-in here (Doggle's own "Here now" line). */
  function mineLine(l: Extract<FeedCourtLine, { kind: 'mine' }>) {
    const m = l.checkin;
    const facts = [m.queued ? 'Saved with no signal' : m.playing ? 'Playing now' : 'Checked in', `until ${clock(m.expiresAt)}`];
    return (
      <View style={styles.line}>
        <View style={[styles.kindIcon, { backgroundColor: c.primaryLight }]}>
          <Icon name={m.playing ? 'play' : 'pin'} size={18} color={c.primary} />
        </View>
        <View style={styles.body}>
          <Text style={t.title} numberOfLines={1}>
            You
          </Text>
          <Text style={[t.meta, { color: c.success }]} numberOfLines={1}>
            {facts.join(' · ')}
          </Text>
        </View>
        {trailing(l, 'your check-in')}
      </View>
    );
  }

  function stopLine(l: Extract<FeedCourtLine, { kind: 'stop' }>) {
    const s = l.stop;
    const plan = s.status === 'planned' ? playModeNowLine(s.windows, new Date(Math.max(now, Date.parse(s.at)))) : '';
    return (
      <View style={styles.line}>
        <View style={[styles.kindIcon, { backgroundColor: c.primaryLight }]}>
          <Icon name="calendar-event" size={18} color={c.primary} />
        </View>
        <View style={styles.body}>
          <Text style={t.title} numberOfLines={1}>
            You · your routine
          </Text>
          <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1}>
            {s.status === 'cancelled' ? `Skipped · ${stopClock(s.at)}–${clock(s.endAt)}` : plan || `${stopClock(s.at)}–${clock(s.endAt)}`}
          </Text>
        </View>
        {trailing(l, 'your routine stop')}
      </View>
    );
  }

  /** My one-off planned check-in here (Doggle's "At 5:30 PM ▾" on a planned visit). */
  function planLine(l: Extract<FeedCourtLine, { kind: 'plan' }>) {
    const p = l.plan;
    return (
      <View style={styles.line}>
        <View style={[styles.kindIcon, { backgroundColor: c.primaryLight }]}>
          <Icon name="calendar-event" size={18} color={c.primary} />
        </View>
        <View style={styles.body}>
          <Text style={t.title} numberOfLines={1}>
            You · planned check-in
          </Text>
          <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1}>
            {`${stopClock(p.at)}–${clock(p.endAt)}`}
          </Text>
        </View>
        {trailing(l, 'your planned check-in')}
      </View>
    );
  }

  const header = courtHeaderActions({
    day,
    hereMine: card.hereMine,
    friendHere: card.lines.some((l) => l.kind === 'here'),
    ...actions.headerFacts(card),
  });
  // Two actions leave the name little room: let it wrap rather than cut (Doggle).
  const twoActions = header.length > 1;

  return (
    <View style={[styles.card, { borderColor: c.border }]}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerName}
          onPress={() => actions.openCourt(card)}
          accessibilityRole="button"
          accessibilityLabel={`${card.venueName}. Open the court`}
        >
          <Icon name={card.starred ? 'star' : 'pin'} size={16} color={c.primary} />
          <Text style={[t.title, styles.shrink]} numberOfLines={twoActions ? 2 : 1}>
            {card.venueName}
          </Text>
          <Icon name="chevron-right" size={16} color={c.textMuted} />
        </TouchableOpacity>
        {header.length > 0 ? (
          <View style={styles.headerActions}>
            {header.map((a) => {
              switch (a) {
                case 'onMyWaySent':
                  return (
                    <View
                      key={a}
                      style={styles.sent}
                      accessible
                      accessibilityLabel={`You told your friends at ${card.venueName} you're on the way`}
                    >
                      <Text style={[t.meta, { color: c.textSub }]}>On the way</Text>
                      <Icon name="check-mark" size={12} color={c.textSub} />
                    </View>
                  );
                case 'onMyWay':
                  return (
                    <FeedHeaderAction
                      key={a}
                      label="On my way"
                      options
                      {...actions.headerState(card, 'onMyWay')}
                      onPress={() => actions.onMyWay(card)}
                      accessibilityLabel={`Tell friends at ${card.venueName} you're on the way`}
                    />
                  );
                case 'checkIn':
                  return (
                    <FeedHeaderAction
                      key={a}
                      label="Check in"
                      options
                      {...actions.headerState(card, 'checkIn')}
                      onPress={() => actions.checkInOptions(card)}
                      accessibilityLabel={`Check in at ${card.venueName}: options`}
                    />
                  );
                case 'plan':
                  return (
                    <FeedHeaderAction
                      key={a}
                      label="Plan"
                      options
                      {...actions.headerState(card, 'plan')}
                      onPress={() => actions.plan(card)}
                      accessibilityLabel={`Plan a check-in at ${card.venueName} tomorrow: pick a time`}
                    />
                  );
              }
            })}
          </View>
        ) : null}
      </View>
      {crowd ? (
        <Text style={[t.meta, styles.crowd, { color: c.textSub }]} numberOfLines={1}>
          {crowd}
        </Text>
      ) : null}

      <View style={styles.rows}>
        {shown.length === 0 ? (
          day === 'today' && !friendsFailed ? (
            <Text style={[t.meta, { color: c.textSub }]}>Nothing planned</Text>
          ) : (
            <Text style={[t.meta, { color: c.textSub }]}>
              {day === 'today' ? "Couldn't load who's here. Pull down to try again." : 'Nothing planned yet.'}
            </Text>
          )
        ) : null}
        {shown.map((l) => {
          if (l.kind === 'agenda') {
            return (
              <View key={l.key} style={styles.agendaRow}>
                {actions.renderAgenda(l, card, day)}
              </View>
            );
          }
          const own = l.kind === 'stop' || l.kind === 'mine' || l.kind === 'plan';
          // Over (Doggle's isPast): a visit that ended, a skipped stop, a stop or plan whose time has passed.
          const past = lineIsPast(sheetLineFacts(l), now);
          return (
            <View
              key={l.key}
              style={[styles.row, own && [styles.ownRow, { backgroundColor: c.successLight }], past && styles.past]}
            >
              {l.kind === 'stop' ? stopLine(l) : l.kind === 'plan' ? planLine(l) : l.kind === 'mine' ? mineLine(l) : personLine(l)}
            </View>
          );
        })}
      </View>

      {more > 0 || all ? (
        <TouchableOpacity
          style={styles.seeAll}
          onPress={() => setAll((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: all }}
        >
          <Text style={[t.meta, { color: c.primary }]}>{all ? 'Show fewer' : `See all (${more} more)`}</Text>
          <Icon name={all ? 'chevron-up' : 'chevron-down'} size={14} color={c.primary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: HAIRLINE, borderRadius: RADIUS.lg, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  headerName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  sent: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
  agendaRow: { marginHorizontal: -SPACE.xs },
  crowd: { marginTop: SPACE.xxs },
  shrink: { flexShrink: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minWidth: 0 },
  rows: { gap: SPACE.xs, marginTop: SPACE.sm },
  row: { paddingVertical: SPACE.xs },
  line: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  ownRow: { marginHorizontal: -SPACE.sm, paddingHorizontal: SPACE.sm, borderRadius: RADIUS.md },
  past: { opacity: 0.55 },
  body: { flex: 1, minWidth: 0, gap: SPACE.xxs / 2 },
  // Things get rounded-square tiles (people keep round avatars).
  kindIcon: { width: AVATAR, height: AVATAR, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  // The player's own avatar emoji (content, not chrome).
  emoji: { fontSize: 20 },
  seeAll: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, paddingTop: SPACE.xs },
});
