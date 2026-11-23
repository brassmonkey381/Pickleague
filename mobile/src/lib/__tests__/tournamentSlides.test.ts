// PKL-070: the multi-slide tournament share's data (lib/tournamentSlides), through the real standings builder,
// for pool play, single elimination and double elimination, mid-tournament and finished.
import { describe, it, expect } from 'vitest';
import { labTournaments, type LabTournamentId } from '../tournamentSlidesLab';
import {
  RESULTS_CAP,
  buildTournamentSlides,
  packSections,
  resultBoxes,
  slideFormatLine,
  slideIndexOf,
  slideStageLabel,
  type SlideSection,
  type TournamentSlides,
} from '../tournamentSlides';
import {
  bracketCardModel,
  shareTemplateLabel,
  shareTemplatesForModel,
  slideShareGuide,
  slideShareToast,
} from '../shareCards';

const all = labTournaments();
const get = (id: LabTournamentId) => all.find((t) => t.id === id)!;
const labels = (ss: SlideSection[] | null | undefined) => (ss ?? []).map((s) => s.label);
const rows = (s: TournamentSlides, t = 0) => s.standings!.tables[t].rows.map((r) => [r.place, r.name, r.record, r.me]);
const myBoxes = (ss: SlideSection[] | null | undefined) => (ss ?? []).flatMap((s) => s.matches).filter((m) => m.me);

describe('every lab tournament', () => {
  it('marks the sharer on every slide it has', () => {
    for (const t of all) {
      const s = t.slides;
      const d = s.draw;
      const inDraw = d.kind === 'pools' ? d.pools.some((p) => p.teams.some((x) => x.me))
        : d.kind === 'bracket' ? d.section.matches.some((m) => m.me) : d.teams.some((x) => x.me);
      expect(inDraw, t.id).toBe(true);
      if (s.results) expect(myBoxes([...s.results.main, ...(s.results.winners ?? []), ...(s.results.losers ?? [])]).length, t.id).toBeGreaterThan(0);
      if (s.standings) expect(s.standings.tables.some((x) => x.rows.some((r) => r.me)), t.id).toBe(true);
      expect(s.pages[0]).toBe('draw');
      expect(s.pages.length).toBeGreaterThanOrEqual(1);
      expect(s.pages.length).toBeLessThanOrEqual(3);
      if (s.results) expect(resultBoxes(s.results)).toBeLessThanOrEqual(RESULTS_CAP);
    }
  });
  it('never uses a middle dot (the copy rule)', () => {
    for (const t of all) expect(JSON.stringify(t.slides), t.id).not.toContain('·');
  });
  it('shows short names only (no full last names)', () => {
    for (const t of all) {
      const j = JSON.stringify(t.slides);
      for (const full of ['Alex Rivera', 'Pat Doyle', 'Maximiliana-Josephine Vasquez', 'Sam Lee', 'Sam Long']) expect(j, t.id).not.toContain(full);
    }
  });
});

describe('pool play', () => {
  it('just drawn: one slide, the pools by seed', () => {
    const s = get('pool-drawn').slides;
    expect(s.pages).toEqual(['draw']);
    expect(s.formatLine).toBe('Pool play, 2 pools, top 2 per pool to the playoff, third place match');
    expect(s.fieldLine).toBe('8 teams, doubles');
    expect(s.statusLine).toBe('0 of 12 matches played');
    if (s.draw.kind !== 'pools') throw new Error('pools');
    expect(s.draw.pools.map((p) => [p.label, p.teams.map((x) => x.seed)])).toEqual([['Pool A', [1, 4, 5, 8]], ['Pool B', [2, 3, 6, 7]]]);
    // Two "Sam L"s are told apart (shortNamer).
    expect(s.draw.pools[0].teams[0].name).toBe('Sam Le. & Sam Lo.');
    expect(s.draw.pools[0].teams[1]).toEqual({ name: 'Alex R. & Pat D.', seed: 4, me: true });
    expect(s.draw.then).toEqual(['Semifinals', 'Third place', 'Final']);
  });

  it('mid-pools: three slides, pool results with the unplayed matches, the playoff still to play, pool tables now', () => {
    const s = get('pool-mid').slides;
    expect(s.pages).toEqual(['draw', 'results', 'standings']);
    expect(s.statusLine).toBe('8 of 12 matches played');
    const r = s.results!;
    expect(r.winners).toBeNull();
    expect(r.main.map((x) => [x.label, x.state, x.matches.length])).toEqual([
      ['Pool A', 'now', 6], ['Pool B', 'now', 6], ['Semifinals', 'next', 0], ['Third place', 'next', 0], ['Final', 'next', 0],
    ]);
    expect(r.main[0].matches.filter((m) => m.win).length).toBe(4);
    expect(r.main[0].matches[1]).toMatchObject({ sa: 11, sb: 8, win: 'a', me: true });
    expect(s.standings!.title).toBe('Standings now');
    expect(s.standings!.tables.map((t) => t.label)).toEqual(['Pool A', 'Pool B']);
    expect(rows(s).slice(0, 2)).toEqual([['1st', 'Sam Le. & Sam Lo.', '2-0', false], ['2nd', 'Alex R. & Pat D.', '2-0', true]]);
  });

  it('draws each pool as a pool sheet: scores from each team side, empty still to play', () => {
    const g = get('pool-mid').slides.results!.main[0].grid!;
    expect(g.teams.map((t) => t.seed)).toEqual([1, 4, 5, 8]);
    expect(g.teams[1].me).toBe(true);
    // me (row 2) beat seed 5 11-8 and seed 8 11-9; v seed 1 not played yet
    expect(g.cells[1]).toEqual(['', null, '11-8', '11-9']);
    expect(g.cells[2][1]).toBe('8-11');
    expect(g.won[1]).toEqual([null, null, true, true]);
    expect(g.won[2][1]).toBe(false);
  });

  it('mid-playoff: places so far, finalists still a range', () => {
    const s = get('pool-playoff').slides;
    expect(labels(s.results!.main)).toEqual(['Pool A', 'Pool B', 'Semifinals', 'Third place', 'Final']);
    expect(s.results!.main[2].state).toBe('now');
    expect(s.standings!.title).toBe('Places so far');
    expect(s.standings!.note).toBeTruthy();
  });

  it('finished: final standings from the stored places, the sharer 2nd', () => {
    const t = get('pool-done');
    const s = t.slides;
    expect(s.finished).toBe(true);
    expect(s.statusLine).toBe('Final results');
    expect(s.results!.main.every((x) => x.state === 'done')).toBe(true);
    expect(s.standings!.title).toBe('Final standings');
    expect(rows(s).slice(0, 3)).toEqual([
      ['1', 'Kim R. & Lee K.', '5-0', false],
      ['2', 'Alex R. & Pat D.', '4-1', true],
      ['3', 'Mo F. & Lu C.', '3-2', false],
    ]);
    expect(t.rank).toBe(2);
  });
});

describe('single elimination', () => {
  it('mid-bracket: round 1 with seeds in bracket order, the Final to come, still in / out', () => {
    const s = get('se-mid').slides;
    expect(s.formatLine).toBe('Single elimination');
    if (s.draw.kind !== 'bracket') throw new Error('bracket');
    expect(s.draw.section.label).toBe('Round 1');
    expect(s.draw.section.matches.map((m) => [m.a?.seed, m.b?.seed])).toEqual([[1, 8], [4, 5], [2, 7], [3, 6]]);
    expect(s.draw.then).toEqual(['Round 2', 'Final']);
    expect(s.results!.main.map((x) => [x.label, x.state])).toEqual([['Round 1', 'done'], ['Round 2', 'now'], ['Final', 'next']]);
    const [still, out] = s.standings!.tables;
    expect(still.label).toBe('Still in');
    expect(still.rows.map((r) => r.name)).toEqual(['Sam Le. & Sam Lo.', 'Kim R. & Lee K.', 'Alex R. & Pat D.']);
    expect(out.rows[0]).toMatchObject({ name: 'Ana P. & Raj T.', note: 'out in Round 2' });
    expect(out.rows.slice(1).every((r) => r.note === 'out in Round 1')).toBe(true);
  });

  it('finished: the Final decided, final places', () => {
    const s = get('se-done').slides;
    expect(s.results!.main.map((x) => [x.label, x.state])).toEqual([['Round 1', 'done'], ['Round 2', 'done'], ['Final', 'done']]);
    expect(s.results!.main[2].matches[0]).toMatchObject({ sa: 11, sb: 8, win: 'a', me: true });
    expect(s.standings!.title).toBe('Final standings');
    expect(rows(s).slice(0, 2)).toEqual([['1', 'Sam Le. & Sam Lo.', '3-0', false], ['2', 'Alex R. & Pat D.', '2-1', true]]);
  });
});

describe('double elimination', () => {
  it('mid-bracket: winners | losers columns, one-loss players still in', () => {
    const s = get('de-mid').slides;
    expect(s.formatLine).toBe('Double elimination, out after 2 losses');
    expect(s.fieldLine).toBe('8 players, singles');
    if (s.draw.kind !== 'bracket') throw new Error('bracket');
    expect(s.draw.section.label).toBe('Winners Round 1');
    expect(labels(s.results!.winners)).toEqual(['Winners Round 1', 'Winners Round 2', 'Winners Round 3']);
    expect(labels(s.results!.losers)).toEqual(['Losers Round 1', 'Losers Round 2']);
    expect(s.results!.main).toEqual([]);
    const [still, out] = s.standings!.tables;
    expect(still.rows.find((r) => r.me)).toMatchObject({ record: '2-0', note: null });
    expect(still.rows.find((r) => r.name === 'Kim R.')).toMatchObject({ record: '1-1', note: 'one loss' });
    expect(out.rows.map((r) => r.name).sort()).toEqual(['Bo H.', 'Di O.', 'Mo F.']);
  });

  it('finished: the Grand Final under both brackets, final places', () => {
    const s = get('de-done').slides;
    expect(labels(s.results!.losers)).toEqual(['Losers Round 1', 'Losers Round 2', 'Losers Round 3', 'Losers Round 4']);
    expect(labels(s.results!.main)).toEqual(['Grand Final']);
    expect(rows(s).slice(0, 3)).toEqual([['1', 'Sam L.', '4-0', false], ['2', 'Alex R.', '3-2', true], ['3', 'Kim R.', '3-2', false]]);
  });
});

describe('a big round robin', () => {
  it('folds the results to my matches under the cap, with the rest counted', () => {
    const s = get('rr-big').slides;
    expect(s.draw.kind).toBe('field');
    const sec = s.results!.main[0];
    expect(sec.label).toBe('Round robin');
    expect(sec.matches.every((m) => m.me)).toBe(true);
    expect(sec.matches.length + sec.more).toBe(45);
  });
});

describe('pieces', () => {
  it('names stages short', () => {
    expect(slideStageLabel('Finals')).toBe('Final');
    expect(slideStageLabel('Third Place Match')).toBe('Third place');
    expect(slideStageLabel('Single Elim Schedule')).toBe('Round 1');
    expect(slideStageLabel('Round Robin Schedule')).toBe('Round robin');
    expect(slideStageLabel('Grand Final (Reset)')).toBe('Grand Final (Reset)');
  });
  it('says the format in a line', () => {
    expect(slideFormatLine('round_robin', { pools: 0, playoffFormat: 'top_4', thirdPlace: false })).toBe('Round robin, top 4 to the playoff');
    expect(slideFormatLine('pool_play', { pools: 3, playoffFormat: 'top_1_per_pool' })).toBe('Pool play, 3 pools, pool winners to the playoff');
  });
  it('pairs single-box sections side by side', () => {
    const sec = (label: string, n: number): SlideSection => ({ label, state: 'done', more: 0, matches: Array.from({ length: n }, () => ({ a: null, b: null, sa: null, sb: null, win: null, bye: false, me: false })) });
    expect(packSections([sec('A', 6), sec('SF', 2), sec('3rd', 1), sec('F', 1), sec('X', 1)]).map((r) => r.map((s) => s.label)))
      .toEqual([['A'], ['SF'], ['3rd', 'F'], ['X']]);
  });
  it('a share with nothing played yet still has the draw', () => {
    const s = buildTournamentSlides({ ...get('se-mid').input, matches: get('se-mid').input.matches.map((m) => ({ ...m, status: 'scheduled', winner_team: null })), standings: null });
    expect(s.pages).toEqual(['draw']);
    expect(s.results).toBeNull();
  });
});

describe('the studio', () => {
  const t = get('pool-done');
  const model = bracketCardModel({ title: t.input.title, rank: 2, of: 8, wins: 4, losses: 1, steps: [], slides: t.slides });
  it('offers a layout per slide right after the poster, none with photos', () => {
    expect(shareTemplatesForModel(0, model)).toEqual(['poster', 'slide-1', 'slide-2', 'slide-3', 'big', 'scorecard']);
    expect(shareTemplatesForModel(1, model)).not.toContain('slide-1');
    const one = bracketCardModel({ ...{ title: 'x', rank: null, of: null, wins: 0, losses: 0, steps: [] }, slides: get('pool-drawn').slides });
    expect(shareTemplatesForModel(0, one).filter((x) => x.startsWith('slide'))).toEqual(['slide-1']);
  });
  it('names the slides and walks the sharer through them', () => {
    expect(shareTemplateLabel('slide-2', model)).toBe('Slide 2 of 3: Results');
    expect(shareTemplateLabel('poster', model)).toBe('Poster');
    expect(slideIndexOf('slide-3')).toBe(2);
    expect(slideIndexOf('poster')).toBe(-1);
    expect(slideShareGuide(0, 3)).toContain('Save Image');
    expect(slideShareGuide(0, 3)).toContain('all 3');
    expect(slideShareToast(0, 3)).toBe('Slide 1 of 3 done. Swipe to slide 2 and share it the same way.');
    expect(slideShareToast(2, 3)).toContain('carousel');
    expect(slideShareToast(-1, 3)).toBeNull();
  });
});
