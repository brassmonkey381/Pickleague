// The window editor's modes (TimeWindowsEditor `modes`): Closed group, Open
// play and Drill, each with its theme colour. One list for the routine
// editor, a one-off plan's editor and a check-in's own windows.
import { PLAY_MODE_LABEL, type PlayMode } from '../../lib/courtRoutineRules';

export type PlayModeOption = { value: PlayMode; label: string; color: string };

export function playModeOptions(c: { warning: string; success: string; info: string }): PlayModeOption[] {
  return [
    { value: 'closed', label: PLAY_MODE_LABEL.closed, color: c.warning },
    { value: 'open', label: PLAY_MODE_LABEL.open, color: c.success },
    { value: 'drill', label: PLAY_MODE_LABEL.drill, color: c.info },
  ];
}
