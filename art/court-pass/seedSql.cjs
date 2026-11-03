// Reads the rows SERVER seeds for the Court Pass items out of
// supabase/migration_court_pass_cycles_*.sql, so build.mjs and
// mobile/src/lib/__tests__/courtArt.test.ts compare the art against the real
// seed instead of a copy of it.
//
// It understands the two insert shapes the repo uses:
//   insert into public.<table> (cols) values (...), (...) [on conflict ...]
//   insert into public.<table> (cols) select ... from (values (...), (...)) [as] v(cols) ...
// and returns each row as { column: value }: a quoted string unquoted, a
// number as a number, a '...'::jsonb literal parsed as JSON, null as null, and
// anything else (an expression) as its SQL text.
const fs = require('node:fs');

/** Splits SQL into tokens: strings, dollar-quoted strings, words, numbers, punctuation; comments dropped. */
function tokenize(sql) {
  const out = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (sql.startsWith('--', i)) { const e = sql.indexOf('\n', i); i = e < 0 ? sql.length : e; continue; }
    if (sql.startsWith('/*', i)) { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; continue; }
    if (ch === "'") {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= sql.length) throw new Error('unterminated string in the seed SQL.');
        if (sql[j] === "'" && sql[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (sql[j] === "'") break;
        s += sql[j++];
      }
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const dq = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40));
    if (dq) {
      const e = sql.indexOf(dq[0], i + dq[0].length);
      if (e < 0) throw new Error(`unterminated ${dq[0]} string in the seed SQL.`);
      out.push({ t: 'str', v: sql.slice(i + dq[0].length, e) });
      i = e + dq[0].length;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(sql.slice(i, i + 40));
    if (num && !/[A-Za-z_]/.test(sql[i - 1] || '')) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(sql.slice(i, i + 200));
    if (word) { out.push({ t: 'word', v: word[0] }); i += word[0].length; continue; }
    if (sql.startsWith('::', i)) { out.push({ t: 'p', v: '::' }); i += 2; continue; }
    out.push({ t: 'p', v: ch });
    i++;
  }
  return out;
}

const isP = (tok, v) => tok && tok.t === 'p' && tok.v === v;
const isW = (tok, v) => tok && tok.t === 'word' && tok.v.toLowerCase() === v;

/** From tokens[i] = '(' returns { items: token[][] (split on top-level commas), end: index after ')' }. */
function group(tokens, i) {
  const items = [[]];
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j];
    if (isP(t, '(')) { depth++; if (depth === 1) continue; }
    if (isP(t, ')')) { depth--; if (depth === 0) return { items, end: j + 1 }; }
    if (depth === 1 && isP(t, ',')) { items.push([]); continue; }
    items[items.length - 1].push(t);
  }
  throw new Error('unbalanced parentheses in the seed SQL.');
}

function value(toks) {
  if (toks.length === 1 && toks[0].t === 'str') return toks[0].v;
  if (toks.length === 1 && toks[0].t === 'num') return toks[0].v;
  if (toks.length === 1 && isW(toks[0], 'null')) return null;
  if (toks.length === 1 && (isW(toks[0], 'true') || isW(toks[0], 'false'))) return toks[0].v.toLowerCase() === 'true';
  if (toks.length === 3 && toks[0].t === 'str' && isP(toks[1], '::') && /^jsonb?$/i.test(toks[2].v)) {
    try { return JSON.parse(toks[0].v); } catch { return toks[0].v; }
  }
  if (toks.length === 3 && toks[0].t === 'str' && isP(toks[1], '::')) return toks[0].v;
  return toks.map((t) => (t.t === 'str' ? `'${t.v}'` : String(t.v))).join(' ');
}

const names = (g) => g.items.map((it) => (it[0] ? String(it[0].v).toLowerCase() : ''));

/** Every row inserted into `table` (e.g. 'home_items') in the SQL text, as { column: value }. */
function seedRows(sql, table) {
  const tokens = tokenize(sql);
  const rows = [];
  for (let i = 0; i < tokens.length - 3; i++) {
    if (!isW(tokens[i], 'insert') || !isW(tokens[i + 1], 'into')) continue;
    const name = tokens[i + 2].v.toLowerCase().replace(/^public\./, '');
    if (name !== table || !isP(tokens[i + 3], '(')) continue;
    const head = group(tokens, i + 3);
    let cols = names(head);
    let j = head.end;
    const viaSelect = isW(tokens[j], 'select');
    if (viaSelect) {
      // Find the "(values" that feeds the select.
      while (j < tokens.length && !(isP(tokens[j], '(') && isW(tokens[j + 1], 'values'))) j++;
      if (j >= tokens.length) continue;
      j += 2;
    } else if (isW(tokens[j], 'values')) j += 1;
    else continue;
    const tuples = [];
    while (isP(tokens[j], '(')) {
      const g = group(tokens, j);
      tuples.push(g.items.map(value));
      j = g.end;
      if (isP(tokens[j], ',')) j++;
      else break;
    }
    if (viaSelect && isP(tokens[j], ')')) {
      // ") [as] v (cols)": the alias names the values columns.
      let k = j + 1;
      if (isW(tokens[k], 'as')) k++;
      if (tokens[k] && tokens[k].t === 'word' && isP(tokens[k + 1], '(')) cols = names(group(tokens, k + 1));
    }
    for (const t of tuples) rows.push(Object.fromEntries(cols.map((c, n) => [c, t[n]])));
  }
  return rows;
}

/** seedRows for a file; throws, naming the file, when it is missing. */
function seedRowsFromFile(file, table) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: SERVER writes it (docs/court-pass.md, Server, file 3).`);
  return seedRows(fs.readFileSync(file, 'utf8'), table);
}

module.exports = { tokenize, seedRows, seedRowsFromFile };
