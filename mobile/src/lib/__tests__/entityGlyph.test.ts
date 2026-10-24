import { describe, it, expect } from 'vitest';
import {
  ENTITY_GLYPH,
  ENTITY_ICON,
  entityGlyph,
  entityIcon,
  entityTileColors,
  joinFacts,
  leagueRoleChip,
  myRegistrationChip,
  playerCountLabel,
  tournamentStatusChip,
} from '../entityGlyph';
import { LIGHT } from '../theme';

describe('entity glyphs', () => {
  it('tournaments are the trophy, leagues the ball, drills the paddle', () => {
    expect(entityGlyph('tournament')).toBe('🏆');
    expect(entityGlyph('league')).toBe('🎾');
    expect(entityGlyph('drill')).toBe('🏓');
  });

  it('no two kinds share a glyph', () => {
    const glyphs = Object.values(ENTITY_GLYPH);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('drawn glyphs: pickleball league, trophy tournament, paddle drill, pickle pickles', () => {
    expect(entityIcon('league')).toBe('pickleball');
    expect(entityIcon('tournament')).toBe('trophy');
    expect(entityIcon('drill')).toBe('paddle');
    expect(entityIcon('pickles')).toBe('pickle');
    expect(entityIcon('court')).toBe('pin');
  });

  it('only event and season share a drawn glyph (both are dates)', () => {
    const byIcon = new Map<string, string[]>();
    for (const [kind, icon] of Object.entries(ENTITY_ICON)) byIcon.set(icon, [...(byIcon.get(icon) ?? []), kind]);
    const shared = [...byIcon.values()].filter((kinds) => kinds.length > 1);
    expect(shared).toEqual([['event', 'season']]);
  });

  it('every kind has both an emoji and a glyph', () => {
    expect(Object.keys(ENTITY_ICON).sort()).toEqual(Object.keys(ENTITY_GLYPH).sort());
  });

  it('tile colours come from the theme', () => {
    expect(entityTileColors('league', LIGHT)).toEqual({ bg: LIGHT.primaryLight, border: LIGHT.primary });
    expect(entityTileColors('court', LIGHT)).toEqual({ bg: LIGHT.surfaceAlt, border: LIGHT.border });
  });
});

describe('row text helpers', () => {
  it('joinFacts drops empty parts', () => {
    expect(joinFacts(['Lake Merritt', null, '', '  ', false, undefined, '3 players'])).toBe('Lake Merritt · 3 players');
    expect(joinFacts([])).toBe('');
  });

  it('never says 0 players', () => {
    expect(playerCountLabel(0)).toBeNull();
    expect(playerCountLabel(null)).toBeNull();
    expect(playerCountLabel(1)).toBe('1 player');
    expect(playerCountLabel(12)).toBe('12 players');
  });

  it('role chips: none for non-members or an unknown role', () => {
    expect(leagueRoleChip('admin')?.label).toBe('Admin');
    expect(leagueRoleChip('co-admin')?.label).toBe('Co-admin');
    expect(leagueRoleChip('member')?.label).toBe('Member');
    expect(leagueRoleChip('unknown')).toBeNull();
    expect(leagueRoleChip(null)).toBeNull();
  });

  it('tournament chips never echo a raw status', () => {
    expect(tournamentStatusChip('registration')?.label).toBe('Open');
    expect(tournamentStatusChip('weird')).toBeNull();
    expect(myRegistrationChip('pending', true)?.label).toBe('Invited');
    expect(myRegistrationChip('pending')?.label).toBe('Requested');
    expect(myRegistrationChip('approved')?.label).toBe('Registered');
    expect(myRegistrationChip('rejected')).toBeNull();
    expect(myRegistrationChip(null)).toBeNull();
  });
});
