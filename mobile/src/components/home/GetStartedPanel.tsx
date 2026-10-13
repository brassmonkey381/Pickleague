// GET STARTED (plan section 3): ONE Panel holding the three starter quests and,
// as extra rows, the guest "save your account" and DUPR import offers (they
// used to be separate banners above it).
//
//   GET STARTED  0 of 3                      v     44, toggles
//   ○ Join a league                       Go ›     44
//   ○ Set up your profile                 Go ›
//   ✓ Record your first match   [Claim +1000 🥒]
//   👋 Save your account                  Save ›   (guests only)
//
// Expanded by default while the account is under 7 days old; after that it is
// one 44px row ("Get started · 2 of 3 · Claim +500") until tapped. HomeScreen
// hides the whole panel once every step is claimed and no offer is left, and
// owns the hooks, so it knows that without rendering this.
import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { FtueStepRow, type FtueChecklist } from '../FtueChecklistCard';
import { GuestUpgradeRow } from '../GuestUpgradeBanner';
import { DuprImportRow, type DuprImportOffer } from '../DuprImportBanner';

type Props = {
  ftue: FtueChecklist;
  isGuest: boolean;
  dupr: DuprImportOffer;
  /** Open on first render (the account is under 7 days old). */
  defaultOpen: boolean;
  /** The screen's one Emphasis panel (when NOW isn't showing). */
  emphasis: boolean;
  onToggle: (open: boolean) => void;
  /** home.tap target slug + position. */
  onTap: (target: string, position?: number) => void;
};

export default function GetStartedPanel({ ftue, isGuest, dupr, defaultOpen, emphasis, onToggle, onTap }: Props) {
  // The user's own toggle wins; until then it follows defaultOpen, which can
  // flip once the profile (and so the account's age) arrives after mount.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? defaultOpen;
  const showSteps = !ftue.allClaimed;
  const claim = ftue.claimableTotal;
  const progress = showSteps ? `${ftue.completeCount} of ${ftue.steps.length}` : '';
  // Collapsed, the one row still says what's waiting inside it.
  const count = open
    ? progress
    : [
        progress,
        claim > 0 ? `Claim +${claim}` : '',
        isGuest ? 'Save your account' : '',
        dupr.match ? 'DUPR rating found' : '',
      ].filter(Boolean).join(' · ');

  // Rows in order; the last one drops its divider so the Panel edge closes it.
  const rows: { key: string; render: (last: boolean) => React.ReactNode }[] = [];
  if (showSteps) {
    ftue.steps.forEach((st, i) => {
      rows.push({
        key: st.id,
        render: (last) => (
          <FtueStepRow
            key={st.id}
            step={st}
            lastRow={last}
            onClaim={() => { onTap('claim', i); void ftue.claim(st.id); }}
            onGo={() => { onTap('step', i); st.navTo(); }}
          />
        ),
      });
    });
  }
  if (isGuest) {
    rows.push({ key: 'guest', render: (last) => <GuestUpgradeRow key="guest" lastRow={last} onPressed={() => onTap('guest_upgrade')} /> });
  }
  if (dupr.visible) {
    rows.push({ key: 'dupr', render: (last) => <DuprImportRow key="dupr" offer={dupr} lastRow={last} onPressed={(target) => onTap(target)} /> });
  }

  return (
    <Panel padded={false} emphasis={emphasis}>
      <SectionHeader
        title="Get started"
        count={count || undefined}
        open={open}
        onToggle={() => {
          const next = !open;
          setToggled(next);
          onToggle(next);
        }}
        style={styles.header}
      />
      {open ? <View>{rows.map((r, i) => r.render(i === rows.length - 1))}</View> : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: SPACE.md },
});
