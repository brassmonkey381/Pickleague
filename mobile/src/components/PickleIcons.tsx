import React from 'react';
import Svg, { Rect, Circle, Ellipse, G } from 'react-native-svg';

type Props = {
  size?: number;
  color?: string;       // paddle face / primary fill
  handleColor?: string; // grip (paddle only)
};

/**
 * Pickleball paddle, viewBox 24x24, blade-up orientation.
 * Default fill green; grip dark.
 */
export function PaddleIcon({ size = 24, color = '#2e7d32', handleColor = '#1a1a1a' }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {/* Blade — slightly taller-than-wide rounded rect */}
      <Rect x="3.5" y="1" width="17" height="15.5" rx="3.2" ry="3.2" fill={color} />
      {/* Blade outline shadow on bottom edge for depth */}
      <Rect x="3.5" y="14.5" width="17" height="2" rx="1.5" ry="1.5" fill="#000" opacity={0.12} />
      {/* Handle */}
      <Rect x="10.5" y="16" width="3" height="6.5" rx="0.6" ry="0.6" fill={handleColor} />
      {/* Grip wrap (3 thin highlight bands) */}
      <Rect x="10.5" y="17.5" width="3" height="0.4" fill="#fff" opacity={0.25} />
      <Rect x="10.5" y="19.4" width="3" height="0.4" fill="#fff" opacity={0.25} />
      <Rect x="10.5" y="21.3" width="3" height="0.4" fill="#fff" opacity={0.25} />
    </Svg>
  );
}

/**
 * Wiffle/pickleball ball, viewBox 24x24.
 * Default greenish-yellow (Penn Championship chartreuse).
 * 7 visible holes arranged to suggest 3D sphere.
 */
export function BallIcon({ size = 24, color = '#D6E000' }: Props) {
  const hole = '#000';
  const holeOpacity = 0.22;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx="12" cy="12" r="11" fill={color} />
      {/* Subtle rim shading for depth */}
      <Circle cx="12" cy="12" r="11" fill="none" stroke="#000" strokeOpacity={0.08} strokeWidth={1} />
      {/* Highlight (top-left sphere shine) */}
      <Ellipse cx="8" cy="7.5" rx="3.4" ry="2.2" fill="#fff" opacity={0.28} />
      {/* Holes — front-facing */}
      <Circle cx="12" cy="6.2"  r="1.2" fill={hole} opacity={holeOpacity} />
      <Circle cx="12" cy="12.5" r="1.7" fill={hole} opacity={holeOpacity} />
      <Circle cx="12" cy="18.5" r="1.2" fill={hole} opacity={holeOpacity} />
      <Circle cx="7"  cy="9.5"  r="1.3" fill={hole} opacity={holeOpacity} />
      <Circle cx="17" cy="9.5"  r="1.3" fill={hole} opacity={holeOpacity} />
      <Circle cx="7"  cy="15.5" r="1.3" fill={hole} opacity={holeOpacity} />
      <Circle cx="17" cy="15.5" r="1.3" fill={hole} opacity={holeOpacity} />
    </Svg>
  );
}
