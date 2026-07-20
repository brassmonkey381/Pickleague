import React from 'react';
import { ContactPickerModal } from '@just-messin-around/expo-foundation/ui';
import { DeviceContact } from '../lib/contacts';

type Props = {
  visible:   boolean;
  busy?:     boolean;
  onConfirm: (contacts: DeviceContact[]) => void;
  onClose:   () => void;
};

/**
 * Moved to @just-messin-around/expo-foundation/ui (genericized). This adapter
 * keeps the original Pickleague copy — guest-vote invite title, "Text N
 * Guest(s)" CTA, and the Pickleague-specific permission notices — so existing
 * imports (`../components/ContactPickerModal`) keep working unchanged.
 */
export default function PickleagueContactPickerModal(props: Props) {
  return (
    <ContactPickerModal
      {...props}
      title="Invite guests to vote"
      ctaLabel={count => (count === 0 ? 'Pick at least one' : `Text ${count} Guest${count === 1 ? '' : 's'}`)}
      emptyText="No contacts with a phone number."
      searchPlaceholder="Search contacts…"
      unavailableTitle="Contacts unavailable"
      unavailableWebText="Picking contacts works in the mobile app. On the web you can still share the invite link manually."
      unavailableNativeText="Allow Contacts access for Pickleague in your device settings to pick guests to invite."
    />
  );
}
