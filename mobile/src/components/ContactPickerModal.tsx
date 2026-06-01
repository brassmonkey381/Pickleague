import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { loadDeviceContacts, DeviceContact } from '../lib/contacts';
import MultiSelectModal from './MultiSelectModal';

type Props = {
  visible:   boolean;
  busy?:     boolean;
  onConfirm: (contacts: DeviceContact[]) => void;
  onClose:   () => void;
};

/**
 * Pick device phone contacts to group-text a guest event-vote invite. Chrome is
 * provided by MultiSelectModal; this wrapper supplies contacts + the
 * permission/unavailable notice.
 */
export default function ContactPickerModal({ visible, busy = false, onConfirm, onClose }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const isWeb = Platform.OS === 'web';

  const [contacts, setContacts]   = useState<DeviceContact[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    loadDeviceContacts().then(({ available, contacts }) => {
      setAvailable(available);
      setContacts(contacts);
      setLoading(false);
    });
  }, [visible]);

  const notice = !available ? (
    <View style={S.noticeInner}>
      <Text style={S.noticeIcon}>📇</Text>
      <Text style={S.noticeTitle}>Contacts unavailable</Text>
      <Text style={S.noticeBody}>
        {isWeb
          ? 'Picking contacts works in the mobile app. On the web you can still share the invite link manually.'
          : 'Allow Contacts access for Pickleague in your device settings to pick guests to invite.'}
      </Text>
    </View>
  ) : null;

  return (
    <MultiSelectModal<DeviceContact>
      visible={visible}
      title="Invite guests to vote"
      items={contacts}
      loading={loading}
      busy={busy}
      notice={notice}
      emptyText="No contacts with a phone number."
      searchPlaceholder="Search contacts…"
      searchText={ct => `${ct.name} ${ct.phone}`}
      toRow={ct => ({
        id: ct.id,
        primary: ct.name,
        secondary: ct.phone,
        left: (
          <View style={S.avatar}>
            <Text style={S.avatarInitial}>{ct.name[0]?.toUpperCase() ?? '?'}</Text>
          </View>
        ),
      })}
      ctaLabel={count => (count === 0 ? 'Pick at least one' : `Text ${count} Guest${count === 1 ? '' : 's'}`)}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    avatar:        { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primaryLight },
    avatarInitial: { fontSize: 16, fontWeight: '700', color: c.primary },
    noticeInner:   { alignItems: 'center', padding: 32, gap: 8 },
    noticeIcon:    { fontSize: 40 },
    noticeTitle:   { fontSize: 16, fontWeight: '800', color: c.text },
    noticeBody:    { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 19 },
  });
}
