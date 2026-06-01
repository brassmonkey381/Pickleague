// Device contacts wrapper over expo-contacts.
//
// Native only — on web (and where the module/permission is unavailable) this
// returns an empty list with `available: false` so callers can show a fallback.
// Mirrors the lazy-require + platform-guard pattern of lib/clipboard.ts / sms.ts.

import { Platform } from 'react-native';

export type DeviceContact = {
  id: string;
  name: string;
  phone: string;
};

export type ContactsResult = {
  available: boolean; // false = unsupported platform or permission denied
  contacts: DeviceContact[];
};

/**
 * Requests contacts permission and returns contacts that have a phone number,
 * sorted by name. Each contact's first phone number is used.
 */
export async function loadDeviceContacts(): Promise<ContactsResult> {
  if (Platform.OS === 'web') return { available: false, contacts: [] };

  let Contacts: typeof import('expo-contacts');
  try {
    Contacts = require('expo-contacts');
  } catch {
    return { available: false, contacts: [] };
  }

  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== 'granted') return { available: false, contacts: [] };

  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
    sort: Contacts.SortTypes.FirstName,
  });

  const contacts: DeviceContact[] = [];
  for (const c of data ?? []) {
    const phone = c.phoneNumbers?.[0]?.number?.trim();
    const name = (c.name ?? '').trim();
    if (!phone || !name) continue;
    contacts.push({ id: c.id ?? `${name}-${phone}`, name, phone });
  }
  return { available: true, contacts };
}
