/**
 * PKL-090 #4: the app must match the golden screens Brian approved (review page v3, 2026-11-25: "approve all for
 * standings"). For every sample moment, what the Standings card, the You card's wait reason, the final placement
 * and the MLP playoff map say is compared with lib/__dev__/goldens.approved.json.
 *
 * A failure means the app now shows something Brian hasn't approved. Either fix the app, or, if the change is
 * wanted, re-capture the goldens (dev-only /dev/goldens), put them on a review page, and replace the approved
 * file only after Brian approves the new version.
 */
import { describe, expect, it } from 'vitest';
import { goldenMoments } from '../__dev__/goldenSamples';
import approved from '../__dev__/goldens.approved.json';
import { buildStandings, myStanding } from '../../components/tournament/standingsData';
import { waitReason } from '../waitReason';
import { buildMlpPlayoffView } from '../mlpPlayoffView';

function render() {
  return goldenMoments().map(m => {
    const d = buildStandings(m.standings);
    const w = m.wait ? waitReason(m.wait) : null;
    const mine = myStanding(d);
    const map = m.standings.tournament.format === 'mlp'
      ? buildMlpPlayoffView({ rounds: m.standings.savedRounds as any, matches: m.standings.savedMatches as any,
          teams: (m.standings.mlpTeams ?? []) as any, rows: (m.standings.mlpStandings ?? []) as any })
      : null;
    const tables = (d?.tables ?? []).map(t => ({ label: t.label, rows: t.rows.map((r, i) => ({
      pos: i + 1, name: r.name, wl: `${r.wins}-${r.losses}`, pm: (r.pf ?? 0) - (r.pa ?? 0) })) }));
    let placement: { place: string; name: string; section: string; detail: string }[] | null =
      d?.placement?.rows.map(r => ({ place: r.place, name: r.name, section: r.section, detail: r.detail })) ?? null;
    if (map && map.podium.length) placement = [
      ...map.podium.map(p => ({ place: String(p.place), name: p.name, section: 'playoff', detail: '' })),
      ...(map.fourth ? [{ place: '4', name: map.fourth.name, section: 'playoff', detail: '' }] : []),
      ...map.rest.map(r => ({ place: String(r.place), name: r.name, section: 'rest', detail: r.detail })),
    ];
    return { id: m.id, format: m.format, title: m.title, story: m.story, card: w ? { title: w.title, line: w.line } : null,
      record: mine ? `You ${mine.row.wins}-${mine.row.losses}, #${mine.position} of ${mine.of}${mine.table ? ` in ${mine.table}` : ''}` : null,
      tables, placement };
  });
}

describe('PKL-090 approved goldens', () => {
  const now = render();
  it('covers every approved moment, and nothing unapproved', () => {
    expect(now.map(x => x.id)).toEqual((approved as { id: string }[]).map(x => x.id));
  });
  for (const g of approved as { id: string }[]) {
    it(`${g.id} reads exactly as approved`, () => {
      expect(now.find(x => x.id === g.id)).toEqual(g);
    });
  }
});
