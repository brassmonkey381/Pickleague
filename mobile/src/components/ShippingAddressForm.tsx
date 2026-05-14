import React from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

export type ShippingAddress = {
  name:        string;
  line1:       string;
  line2:       string;
  city:        string;
  state:       string;
  postal_code: string;
  country:     string;
  phone:       string;
};

export const EMPTY_ADDRESS: ShippingAddress = {
  name: '', line1: '', line2: '', city: '', state: '',
  postal_code: '', country: 'US', phone: '',
};

export function isAddressValid(a: ShippingAddress): boolean {
  return !!(a.name.trim() && a.line1.trim() && a.city.trim()
            && a.postal_code.trim() && a.country.trim());
}

type Props = {
  value:    ShippingAddress;
  onChange: (next: ShippingAddress) => void;
  recipientLabel?: string;   // e.g. "Ship to Jane Doe" when gifting
};

export default function ShippingAddressForm({ value, onChange, recipientLabel }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  function set<K extends keyof ShippingAddress>(k: K, v: ShippingAddress[K]) {
    onChange({ ...value, [k]: v });
  }

  return (
    <View style={S.wrap}>
      {recipientLabel && <Text style={S.recipientLabel}>{recipientLabel}</Text>}
      <Text style={S.sectionLabel}>Shipping address</Text>

      <Field label="Full name"      val={value.name}        onChange={v => set('name', v)} />
      <Field label="Address line 1" val={value.line1}       onChange={v => set('line1', v)} />
      <Field label="Address line 2 (optional)" val={value.line2} onChange={v => set('line2', v)} />
      <View style={S.row2}>
        <View style={S.col2}><Field label="City"  val={value.city}  onChange={v => set('city', v)} /></View>
        <View style={S.col1}><Field label="State" val={value.state} onChange={v => set('state', v)} /></View>
      </View>
      <View style={S.row2}>
        <View style={S.col1}><Field label="ZIP / Postal"  val={value.postal_code} onChange={v => set('postal_code', v)} keyboard="default" /></View>
        <View style={S.col1}><Field label="Country"      val={value.country}     onChange={v => set('country', v)} /></View>
      </View>
      <Field label="Phone (optional)" val={value.phone} onChange={v => set('phone', v)} keyboard="phone-pad" />
    </View>
  );
}

function Field({ label, val, onChange, keyboard }: {
  label: string;
  val: string;
  onChange: (v: string) => void;
  keyboard?: 'default' | 'phone-pad';
}) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  return (
    <View style={S.fieldWrap}>
      <Text style={S.fieldLabel}>{label}</Text>
      <TextInput
        style={S.input}
        value={val}
        onChangeText={onChange}
        placeholderTextColor={c.textMuted}
        keyboardType={keyboard ?? 'default'}
        autoCapitalize="words"
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    wrap:           { marginBottom: 10 },
    sectionLabel:   { fontSize: 12, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 8 },
    recipientLabel: { fontSize: 13, fontWeight: '700', color: c.text, marginBottom: 8 },
    fieldWrap:      { marginBottom: 8 },
    fieldLabel:     { fontSize: 11, fontWeight: '600', color: c.textSub, marginBottom: 3 },
    input:          { borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: c.text, backgroundColor: c.surface },
    row2:           { flexDirection: 'row', gap: 8 },
    col1:           { flex: 1 },
    col2:           { flex: 2 },
  });
}
