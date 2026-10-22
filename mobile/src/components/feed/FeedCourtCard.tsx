// One court in one day of the Pickleague Feed: the feed's top layer (Doggle's
// FeedParkCard, with the player's avatar and PLUPR where Doggle shows the
// dog). The header is the court (★ for a starred court, a pin otherwise; tap
// opens its page) with its crowd line and, today, one-tap [Check in] and
// [▶ Play] at this court; tomorrow "Plan ▾". Its lines run in time order:
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
import { useTheme } from '../../lib/ThemeContext';
import { dayLabel, shortTime } from '../../lib/agenda';
import { crowdLineText } from '../../lib/courtCrowd';
import { formatPluprShort } from '../../lib/plupr';
import { playerModeLine, playModeNowLine, type PlayModeRow } from '../../lib/courtRoutineRules';
import { capCourtLines, type DayBandKey, type FeedCourtCard as Card, type FeedCourtLine, type FeedSheetLine } from '../../lib/pickleagueFeed';

const AVATAR = 36;

export type FeedCourtCardActions = {
  openCourt: (card: Card) => void;
  /** "Plan ▾" (tomorrow): the court's options sheet. */
  courtOptions: (card: Card, day: DayBandKey) => void;
  /** Today's [Check in]: one tap, at this court. */
  checkIn: (card: Card) => void;
  /** Today's [▶ Play] (and the empty card's "▶ Start playing"): the start sheet at this court. */
  play: (card: Card) => void;
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
          <Text
            style={t.title}
            numberOfLines={1}
            onPress={() => actions.openPerson(p.userId, p.name)}
            accessibilityRole="link"
          >
            {p.name}
            {p.isCloseFriend ? ' ★' : ''}
          </Text>
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
          <Icon name="calendar" size={18} color={c.primary} />
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
          <Icon name={card.starred ? 'star' : 'pin'} size={15} color={c.primary} />
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
      {/* Today: the crowd line beside one-tap Check in / ▶ Play (the name
          keeps the whole first line, a long court name stays readable). */}
      {day === 'today' ? (
        <View style={styles.subHeader}>
          <Text style={[t.meta, styles.subText, { color: c.textSub }]} numberOfLines={1}>
            {crowd ?? ''}
          </Text>
          <FeedActionPill
            label="Check in"
            iconName="pin"
            onPress={() => actions.checkIn(card)}
            accessibilityLabel={`Check in at ${card.venueName}`}
          />
          <FeedActionPill
            label="▶ Play"
            filled
            onPress={() => actions.play(card)}
            accessibilityLabel={`Start playing at ${card.venueName}`}
          />
        </View>
      ) : crowd ? (
        <Text style={[t.meta, styles.crowd, { color: c.textSub }]} numberOfLines={1}>
          {crowd}
        </Text>
      ) : null}

      <View style={styles.rows}>
        {shown.length === 0 ? (
          day === 'today' && !friendsFailed ? (
            <Text style={[t.meta, { color: c.textSub }]}>
              {'Nothing planned · '}
              <Text
                style={{ color: c.primary }}
                onPress={() => actions.play(card)}
                accessibilityRole="button"
                accessibilityLabel={`Start playing at ${card.venueName}`}
              >
                ▶ Start playing
              </Text>
            </Text>
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
  card: { borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerAction: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  subHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  subText: { flex: 1, minWidth: 0 },
  agendaRow: { marginHorizontal: -4 },
  crowd: { marginTop: 2 },
  shrink: { flexShrink: 1 },
  rows: { gap: 4, marginTop: 8 },
  row: { paddingVertical: 5 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ownRow: { marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 10 },
  past: { opacity: 0.55 },
  body: { flex: 1, minWidth: 0, gap: 1 },
  kindIcon: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 20 },
  seeAll: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingTop: 6 },
});
