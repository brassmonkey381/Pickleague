import React from 'react';
import { Text, TextStyle, StyleProp } from 'react-native';
import { getFlairEffect } from '../lib/nameFlair';
import { getNameStyle, degradeForList, NameStyle } from '../lib/nameStyles';
import {
  PulseName,
  RainbowName,
  SparkleName,
  TypewriterName,
  HolographicName,
} from './NameStyleAnimations';

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
      // Static fallback: only used if we end up here in list mode (which
      // shouldn't happen — degradeForList() converts animated → solid before
      // this function is called). Hero-mode rendering dispatches to the
      // animated sub-components below, never reaching this branch.
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

    // Hero mode + animated recipe → dispatch to dedicated sub-component.
    // (List mode never reaches here because degradeForList() converts
    // animated → solid above.)
    if (effective.kind === 'animated') {
      switch (effective.effect) {
        case 'pulse':
          return (
            <PulseName
              name={name}
              color={effective.base}
              style={style}
              numberOfLines={numberOfLines}
            />
          );
        case 'rainbow':
          return <RainbowName name={name} style={style} numberOfLines={numberOfLines} />;
        case 'sparkle':
          return (
            <SparkleName
              name={name}
              color={effective.base}
              style={style}
              numberOfLines={numberOfLines}
            />
          );
        case 'typewriter':
          return (
            <TypewriterName
              name={name}
              color={effective.base}
              style={style}
              numberOfLines={numberOfLines}
            />
          );
        case 'holographic':
          return (
            <HolographicName
              name={name}
              baseColor={effective.base}
              style={style}
              numberOfLines={numberOfLines}
            />
          );
      }
    }

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
