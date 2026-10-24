// Pickles, drawn one way everywhere (glyphs-ui-plan.md 1.4 rule 3): the pickle
// glyph beside a tabular number, on the foundation's IconValue.
//
//   <PickleAmount amount={50} prefix="+" />          + 🥒 50 in a reward or a price
//   <PickleBalance balance={profile?.pickles} />     the balance; "—" until known
//
// In a sentence, use words instead ("You need 50 pickles to enter").
import React from 'react';
import { IconValue } from '@just-messin-around/expo-foundation/icons';
import type { TextPreset } from '@just-messin-around/expo-foundation/typography';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

/** "1 pickle" / "1,240 pickles", for labels and prose. */
export function picklesLabel(n: number): string {
  return `${n.toLocaleString()} ${Math.abs(n) === 1 ? 'pickle' : 'pickles'}`;
}

type AmountProps = {
  amount: number;
  /** "+" for a reward, "-" for a cost shown as a change. */
  prefix?: '+' | '-' | '';
  preset?: TextPreset;
  /** Text colour; the glyph follows it. Default the brand primary. */
  color?: string;
  iconColor?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  /** Default "50 pickles" (with the sign spelled out for +/-). */
  accessibilityLabel?: string;
};

export function PickleAmount({ amount, prefix = '', preset = 'title', color, iconColor, style, textStyle, accessibilityLabel }: AmountProps) {
  const { colors: c } = useTheme();
  const label =
    accessibilityLabel ??
    (prefix === '+' ? `plus ${picklesLabel(amount)}` : prefix === '-' ? `minus ${picklesLabel(amount)}` : picklesLabel(amount));
  return (
    <IconValue
      iconName="pickle"
      value={`${prefix}${amount.toLocaleString()}`}
      preset={preset}
      color={color ?? c.primary}
      iconColor={iconColor}
      style={style}
      textStyle={textStyle}
      accessibilityLabel={label}
    />
  );
}

type BalanceProps = {
  /** null / undefined until the profile lands: shows "—", never a 0 we can't back up. */
  balance: number | null | undefined;
  preset?: TextPreset;
  color?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

export function PickleBalance({ balance, preset = 'title', color, style, textStyle }: BalanceProps) {
  const { colors: c } = useTheme();
  const known = typeof balance === 'number' && Number.isFinite(balance);
  return (
    <IconValue
      iconName="pickle"
      value={known ? balance.toLocaleString() : '—'}
      preset={preset}
      color={color ?? c.text}
      iconColor={c.primary}
      style={style}
      textStyle={textStyle}
      accessibilityLabel={known ? picklesLabel(balance) : 'Pickle balance loading'}
    />
  );
}
