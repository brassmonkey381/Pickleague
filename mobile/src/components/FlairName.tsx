import React from 'react';
import { Text, TextStyle, StyleProp } from 'react-native';
import { getFlairEffect } from '../lib/nameFlair';
import { getNameStyle, degradeForList, NameStyle } from '../lib/nameStyles';

type Props = {
  name: string;
  /** Legacy single-color flair (profiles.name_color). Used when `styleId` is not provided. */
  nameColor?: string | null;
  /** New name-style slug (profiles.list_name_style_id / hero_name_style_id). Takes precedence over `nameColor`. */
  styleId?: string | null;
  /**
   * 'hero' (default) allows animated recipes; 'list' degrades animations to
   * their base solid color so dense lists don't flicker.
   */
  mode?: 'hero' | 'list';
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
};

// Resolve a NameStyle recipe into a TextStyle (and optional prefix/suffix).
function styleToTextStyle(recipe: NameStyle): { textStyle: TextStyle; prefix?: string; suffix?: string } {
  switch (recipe.kind) {
    case 'solid':
      return { textStyle: { color: recipe.color } };

    case 'glow':
      return {
        textStyle: {
          color: recipe.color,
          textShadowColor: recipe.color,
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: recipe.radius,
        },
      };

    case 'gradient':
      // No react-native-linear-gradient or MaskedView installed. Fall back to
      // the first stop as the solid color. Wave B may upgrade this to a
      // gradient renderer; until then the color is still distinctive.
      return { textStyle: { color: recipe.stops[0] ?? '#000' } };

    case 'metallic':
      // Metallic = base color + a subtle shineColor shadow to suggest a sheen.
      // A true metallic gradient needs MaskedView; this stays useful without it.
      return {
        textStyle: {
          color: recipe.base,
          textShadowColor: recipe.shineColor,
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 2,
        },
      };

    case 'animated':
      // TODO: Wave B animations — for now render as the base solid color.
      return { textStyle: { color: recipe.base } };
  }
}

export default function FlairName({
  name,
  nameColor,
  styleId,
  mode = 'hero',
  style,
  numberOfLines,
}: Props) {
  // Preferred path: explicit styleId → look up recipe and render.
  const recipe = getNameStyle(styleId);
  if (recipe) {
    const effective = mode === 'list' ? degradeForList(recipe) : recipe;
    const { textStyle } = styleToTextStyle(effective);
    return (
      <Text style={[style, textStyle]} numberOfLines={numberOfLines}>
        {name}
      </Text>
    );
  }

  // Fallback: legacy nameColor + getFlairEffect path. Unchanged behavior.
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
