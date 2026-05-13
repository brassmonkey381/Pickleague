import React from 'react';
import { Text, TextStyle, StyleProp } from 'react-native';
import { getFlairEffect } from '../lib/nameFlair';

type Props = {
  name: string;
  nameColor: string | null | undefined;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
};

export default function FlairName({ name, nameColor, style, numberOfLines }: Props) {
  const fx = getFlairEffect(nameColor);
  if (!fx) return <Text style={style} numberOfLines={numberOfLines}>{name}</Text>;

  const colorStyle: TextStyle = { color: fx.color };
  const glowStyle: TextStyle | undefined = fx.glow ? {
    textShadowColor:  fx.glow.color,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: fx.glow.radius,
  } : undefined;

  return (
    <Text style={[style, colorStyle, glowStyle]} numberOfLines={numberOfLines}>
      {fx.prefix ? `${fx.prefix} ` : ''}{name}{fx.suffix ? ` ${fx.suffix}` : ''}
    </Text>
  );
}
