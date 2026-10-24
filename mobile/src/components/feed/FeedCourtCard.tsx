// One court in one day of the Pickleague Feed: the feed's top layer (Doggle's
// FeedParkCard, with the player's avatar and PLUPR where Doggle shows the
// dog). The header is the court (a star glyph for a starred court, a pin otherwise; tap
// opens its page) with its crowd line and, today, [On my way] (tell friends
// I'm about 15 min out: components/OnMyWaySheet), one-tap [Check in] and
// [(play) Play] at this court; tomorrow "Plan v". Its lines run in time order:
// friends who came and went today (faded), friends here now (with their play
// mode), then what is coming there (league events, booked matches,
// tournaments, drills, votes, my routine stops). Each person / stop line's
// time chip opens what I can do with it; a league line opens its screen. Over
// 6 lines the oldest finished visits give way first.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Avatar, type ChipTone } from '@just-messin-around/expo-foundation/ui';
import { FeedActionPill, FeedTimeChip } from '@just-messin-around/expo-foundation/ui/feed';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { useTheme } from '../../lib/ThemeContext';
import { dayLabel, shortTime } from '../../lib/agenda';
import { crowdLineText } from '../../lib/courtCrowd';
import { formatPluprShort } from '../../lib/plupr';
import { playerModeLine, playModeNowLine, type PlayModeRow } from '../../lib/courtRoutineRules';
import { capCourtLines, type DayBandKey, type FeedCourtCard as Card, type FeedCourtLine, type FeedSheetLine } from '../../lib/pickleagueFeed';

const AVATAR = 36;

export type FeedCourtCardActions = {
  openCourt: (card: Card) => void;
  /** "Plan" + chevron (tomorrow): the court's options sheet. */
  courtOptions: (card: Card, day: DayBandKey) => void;
  /** Today's [Check in]: one tap, at this court. */
  checkIn: (card: Card) => void;
  /** Today's Play pill (and the empty card's "Start playing"): the start sheet at this court. */
  play: (card: Card) => void;
  /** Today's [On my way]: the sheet that tells friends I'm heading there. */
  onMyWay: (card: Card) => void;
  /** 'hidden' (no friends, or friends at the courts off), 'ready', or 'sent'
   *  (this device told friends about this court in the last 30 minutes). */
  onMyWayState: (card: Card) => 'hidden' | 'ready' | 'sent';
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

  function chip(l: Exclude<FeedCourtLine, { kind: 'agenda' }>): { label: string; tone: ChipTone } {
    if (l.kind === 'here') return { label: l.viaSession ? 'Playing now' : 'Here now', tone: 'success' };
    if (l.kind === 'left') return { label: 'Left', tone: 'neutral' };
    if (l.stop.status === 'cancelled') return { label: 'Skipped', tone: 'neutral' };
    const started = Date.parse(l.stop.at) <= now;
    return { label: `At ${stopClock(l.stop.at)}`, tone: started ? 'neutral' : 'warning' };
  }

  function trailing(l: Exclude<FeedCourtLine, { kind: 'agenda' }>, who: string) {
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

  const omw = day === 'today' ? actions.onMyWayState(card) : 'hidden';

  // Today: check in / play right here. Tomorrow: plan (a routine).
  const optionsLabel = day === 'tomorrow' ? 'Plan' : null;

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
          <Text style={[t.title, styles.shrink]} numberOfLines={1}>
            {card.venueName}
          </Text>
          <Icon name="chevron-right" size={16} color={c.textMuted} />
        </TouchableOpacity>
        {optionsLabel ? (
          <TouchableOpacity
            onPress={() => actions.courtOptions(card, day)}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={`${optionsLabel} at ${card.venueName}: options`}
            style={styles.headerAction}
          >
            <Text style={[t.title, { color: c.primary }]}>{optionsLabel}</Text>
            <Icon name="chevron-down" size={14} color={c.primary} />
          </TouchableOpacity>
        ) : null}
      </View>
      {/* Today: the crowd line beside one-tap Check in / Play (the name
          keeps the whole first line, a long court name stays readable). */}
      {day === 'today' ? (
        <View style={styles.subHeader}>
          {/* With three pills the crowd line keeps at least ~120 px; on a
              narrow phone the pills wrap under it as one group. */}
          <Text style={[t.meta, omw === 'hidden' ? styles.subText : styles.subTextWrap, { color: c.textSub }]} numberOfLines={1}>
            {crowd ?? ''}
          </Text>
          <View style={styles.pills}>
            {omw !== 'hidden' ? (
              <FeedActionPill
                label={omw === 'sent' ? 'Told friends' : 'On my way'}
                iconName={omw === 'sent' ? 'check-mark' : 'arrow-right'}
                onPress={() => actions.onMyWay(card)}
                accessibilityLabel={
                  omw === 'sent'
                    ? `You told friends you're on the way to ${card.venueName}. Open On my way`
                    : `On my way to ${card.venueName}: tell friends`
                }
              />
            ) : null}
            <FeedActionPill
              label="Check in"
              iconName="pin"
              onPress={() => actions.checkIn(card)}
              accessibilityLabel={`Check in at ${card.venueName}`}
            />
            <FeedActionPill
              label="Play"
              iconName="play"
              filled
              onPress={() => actions.play(card)}
              accessibilityLabel={`Start playing at ${card.venueName}`}
            />
          </View>
        </View>
      ) : crowd ? (
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
          const own = l.kind === 'stop';
          const past = l.kind === 'left' || (l.kind === 'stop' && l.stop.status === 'cancelled');
          return (
            <View
              key={l.key}
              style={[styles.row, own && [styles.ownRow, { backgroundColor: c.successLight }], past && styles.past]}
            >
              {l.kind === 'stop' ? stopLine(l) : personLine(l)}
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
  headerAction: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
  subHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.xs },
  subText: { flex: 1, minWidth: 0 },
  subTextWrap: { flexGrow: 1, flexShrink: 1, flexBasis: 120, minWidth: 0 },
  pills: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
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
