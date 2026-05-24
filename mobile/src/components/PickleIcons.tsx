import React from 'react';
import Svg, { Rect, Circle, Ellipse, Path } from 'react-native-svg';

type Props = {
  size?: number;
  color?: string;
};

/**
 * Wiffle/pickleball ball, viewBox 24x24.
 * Default greenish-yellow (Penn Championship chartreuse).
 */
export function BallIcon({ size = 24, color = '#D6E000' }: Props) {
  const hole = '#000';
  const holeOpacity = 0.22;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx="12" cy="12" r="11" fill={color} />
      <Circle cx="12" cy="12" r="11" fill="none" stroke="#000" strokeOpacity={0.08} strokeWidth={1} />
      <Ellipse cx="8" cy="7.5" rx="3.4" ry="2.2" fill="#fff" opacity={0.28} />
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

/**
 * Dumbbell, viewBox 24x24. Used for "drill" / "workout" contexts.
 * Default dark grey.
 */
export function DumbbellIcon({ size = 24, color = '#2e2e2e' }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {/* Bar */}
      <Rect x="6" y="10.5" width="12" height="3" rx="0.6" fill={color} />
      {/* Left weight stack: outer + inner plate */}
      <Rect x="1.2" y="7.5" width="2.4" height="9" rx="0.8" fill={color} />
      <Rect x="4" y="5.5" width="2.6" height="13" rx="0.8" fill={color} />
      {/* Right weight stack */}
      <Rect x="17.4" y="5.5" width="2.6" height="13" rx="0.8" fill={color} />
      <Rect x="20.4" y="7.5" width="2.4" height="9" rx="0.8" fill={color} />
    </Svg>
  );
}

/**
 * Single-player silhouette, viewBox 24x24. Used for "singles" contexts.
 * Default dark grey.
 */
export function SoloPlayerIcon({ size = 24, color = '#2e2e2e' }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {/* Head */}
      <Circle cx="12" cy="6.5" r="3.5" fill={color} />
      {/* Shoulders + torso */}
      <Path d="M 4.5,22 L 4.5,16 Q 4.5,11.5 9,11.5 L 15,11.5 Q 19.5,11.5 19.5,16 L 19.5,22 Z" fill={color} />
    </Svg>
  );
}
