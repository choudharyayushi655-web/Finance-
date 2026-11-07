#!/usr/bin/env node
/**
 * sponsors.mjs: tag every firm the radar has found with whether it holds a UK
 * Skilled Worker sponsor licence.
 *
 * 1. Register: the Home Office "Register of licensed sponsors: workers" CSV from
 *    gov.uk. Found through the gov.uk content API (so a new monthly file name is
 *    picked up automatically), filtered to the Skilled Worker route, reduced to
 *    normalised organisation names and cached in .cache/sponsor-register.txt.
 *    It is re-downloaded when the cache is more than 7 days old (the workflow
 *    also keys its cache by week). If gov.uk can't be reached, the last cached
 *    copy is used.
 * 2. Matching, in order:
 *      sponsor-aliases.yml (manual: firm -> register name, or false)
 *      exact match after normalising (case, punctuation, Ltd/PLC/LLP/UK/Group...)
 *      register name starting with the firm's name ("Monzo" -> "Monzo Bank Ltd")
 *      close spelling (Dice similarity >= 0.92)
 * 3. Output: data/sponsors.json { firms: { name: { licensed, register_name, match } } }
 *    and reports/sponsor-unmatched.md listing firms with no match, for review.
 *
 * Usage: node scripts/sponsors.mjs --engine <career-ops dir>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const ENGINE = path.resolve(opt('--engine', '../career-ops'));
const CACHE = '.cache/sponsor-register.txt';
const MAX_AGE_DAYS = 7;
const PAGE_API = 'https://www.gov.uk/api/content/government/publications/register-of-licensed-sponsors-workers';
const PAGE_HTML = 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers';
const UA = 'finance-job-radar (personal job search; github.com/career-ops-hq/career-ops)';

// ------------------------------------------------------------- normalising
const SUFFIX = /\b(limited|ltd|plc|llp|llc|lp|inc|incorporated|corp|corporation|co|company|the|uk|u k|gb|group|holdings?|international|europe|emea|london|services|branch|t a|trading as|com|io|ai)\b/g;
export function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ').replace(/&/g, ' and ').replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}
const bigrams = (s) => { const t = s.replace(/ /g, ''); const out = new Map(); for (let i = 0; i < t.length - 1; i++) { const b = t.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); } return out; };
export function dice(a, b) {
  if (!a || !b) return 0;
  const A = bigrams(a); const B = bigrams(b); let inter = 0; let na = 0; let nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0);
  return (2 * inter) / (na + nb || 1);
}

/** Minimal CSV line parser (quoted fields, doubled quotes). */
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

// --------------------------------------------------------------- register
async function get(url, accept) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

async function findCsvUrl() {
  try {
    const json = JSON.parse(await get(PAGE_API, 'application/json'));
    const docs = [...(json.details?.attachments || []), ...(json.details?.documents || [])];
    const flat = JSON.stringify(docs);
    const m = flat.match(/https:\/\/assets\.publishing\.service\.gov\.uk\/[^"\\]+?\.csv/);
    if (m) return m[0];
  } catch (e) { console.error(`sponsors: content API: ${e.message}`); }
  const html = await get(PAGE_HTML, 'text/html');
  const m = html.match(/https:\/\/assets\.publishing\.service\.gov\.uk\/[^"']+?\.csv/);
  if (!m) throw new Error('no CSV link found on the gov.uk page');
  return m[0];
}

async function loadRegister() {
  const fresh = existsSync(CACHE) && (Date.now() - statSync(CACHE).mtimeMs) < MAX_AGE_DAYS * 86400000
    && /^# downloaded (\d{4}-\d{2}-\d{2})/.test(readFileSync(CACHE, 'utf8').slice(0, 40))
    && (Date.now() - Date.parse(readFileSync(CACHE, 'utf8').slice(13, 23))) < MAX_AGE_DAYS * 86400000;
  if (!fresh) {
    try {
      const url = await findCsvUrl();
      const csv = await get(url, 'text/csv');
      const lines = csv.split(/\r?\n/);
      const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
      const iName = header.findIndex((h) => h.includes('organisation'));
      const iRoute = header.findIndex((h) => h === 'route');
      const names = new Map();
      for (const l of lines.slice(1)) {
        if (!l) continue;
        const c = parseCsvLine(l);
        if (iRoute >= 0 && !/skilled worker/i.test(c[iRoute] || '')) continue;
        const raw = (c[iName] || '').trim();
        const n = normName(raw);
        if (n && !names.has(n)) names.set(n, raw);
      }
      if (names.size < 10000) throw new Error(`only ${names.size} organisations parsed; keeping the old cache`);
      mkdirSync(path.dirname(CACHE), { recursive: true });
      writeFileSync(CACHE, `# downloaded ${new Date().toISOString().slice(0, 10)} from ${url}\n${[...names].map(([n, r]) => `${n}\t${r}`).join('\n')}\n`);
      console.log(`sponsors: downloaded register (${names.size} Skilled Worker sponsors) from ${url}`);
    } catch (e) {
      if (!existsSync(CACHE)) throw e;
      console.error(`sponsors: could not refresh register (${e.message}); using cached copy`);
    }
  }
  const text = readFileSync(CACHE, 'utf8').split('\n');
  const source = text[0].replace(/^# /, '');
  const reg = new Map(text.slice(1).filter(Boolean).map((l) => l.split('\t')));
  return { reg, source };
}

// ----------------------------------------------------------------- matching
const compact = (n) => n.replace(/ /g, '');
const SAFE_TAIL = new Set('bank banking capital financial finance technology technologies tech payments pay markets management partners consulting consultants advisory advisors advisers investments investment securities solutions insurance asset assets wealth research retail energy supply digital labs software systems global operations trading money credit analytics data ventures fintech platform lending loans cards brokers broking asset'.split(' '));
export function matchFirm(firm, reg, aliases, byFirstToken, regCompact = new Map([...reg.keys()].map((k) => [compact(k), k]))) {
  if (Object.prototype.hasOwnProperty.call(aliases, firm)) {
    const a = aliases[firm];
    if (a === false) return { licensed: false, register_name: null, match: 'alias: not licensed' };
    const k = regCompact.get(compact(normName(a)));
    return k ? { licensed: true, register_name: reg.get(k), match: 'alias' } : { licensed: false, register_name: null, match: `alias not on current register (${a})` };
  }
  const n = normName(firm);
  if (!n) return { licensed: false, register_name: null, match: 'none' };
  if (reg.has(n)) return { licensed: true, register_name: reg.get(n), match: 'exact' };
  if (regCompact.has(compact(n))) return { licensed: true, register_name: reg.get(regCompact.get(compact(n))), match: 'exact' };
  const first = n.split(' ')[0];
  const cands = byFirstToken.get(first) || [];
  // Prefix: "Monzo" -> "Monzo Bank". For a one-word name the extra words must be
  // ordinary company words, so "Ember" doesn't match "Ember Construction".
  const pre = cands.filter((r) => r.startsWith(`${n} `))
    .filter((r) => n.includes(' ') ? true : r.slice(n.length + 1).split(' ').every((w) => SAFE_TAIL.has(w)))
    .sort((a, b) => a.length - b.length)[0];
  if (pre && n.length >= 3) return { licensed: true, register_name: reg.get(pre), match: 'prefix' };
  let best = null; let score = 0;
  for (const r of cands) { const d = dice(n, r); if (d > score) { score = d; best = r; } }
  if (best && score >= 0.92) return { licensed: true, register_name: reg.get(best), match: `similar (${score.toFixed(2)})` };
  return { licensed: false, register_name: null, match: 'none' };
}

async function main() {
  const { loadYaml } = await import(pathToFileURL(path.join(ENGINE, 'lib/yaml-document.mjs')).href);
  const { reg, source } = await loadRegister();
  const byFirstToken = new Map();
  for (const n of reg.keys()) { const f = n.split(' ')[0]; if (!byFirstToken.has(f)) byFirstToken.set(f, []); byFirstToken.get(f).push(n); }
  const aliases = existsSync('sponsor-aliases.yml') ? (loadYaml(readFileSync('sponsor-aliases.yml', 'utf8'))?.aliases || {}) : {};

  // Every firm the radar knows about: employer boards, job-board and startup roles, startup list.
  const base = (c) => String(c || '').replace(/\s*\(.*\)$/, '').replace(/^"|"$/g, '').trim();
  const firms = new Set();
  for (const l of (existsSync('data/pipeline.md') ? readFileSync('data/pipeline.md', 'utf8') : '').split('\n')) {
    const c = l.split(' | '); if (l.startsWith('- [') && c[1]) firms.add(base(c[1]));
  }
  for (const e of loadYaml(readFileSync('portals.yml', 'utf8'))?.tracked_companies || []) firms.add(base(e.name));
  if (existsSync('companies_startups.yaml')) for (const c of loadYaml(readFileSync('companies_startups.yaml', 'utf8'))?.companies || []) firms.add(base(c.name));
  firms.delete('');

  const regCompact = new Map([...reg.keys()].map((k) => [k.replace(/ /g, ''), k]));
  const out = {};
  for (const f of [...firms].sort()) out[f] = matchFirm(f, reg, aliases, byFirstToken, regCompact);
  writeFileSync('data/sponsors.json', `${JSON.stringify({ source: `UK Home Office register of licensed sponsors (Skilled Worker), ${source}`, note: 'A licence does not mean a given role will sponsor; check the advert.', firms: out }, null, 1)}\n`);

  const unmatched = Object.entries(out).filter(([, v]) => !v.licensed);
  const fuzzy = Object.entries(out).filter(([, v]) => /^(prefix|similar)/.test(v.match));
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/sponsor-unmatched.md', [
    '# Sponsor licence: firms to review', '',
    `Register: ${source}. ${firms.size} firms checked, ${firms.size - unmatched.length} matched, ${unmatched.length} not found.`, '',
    'Roles at firms **not found** are kept on JOBS.md but not sent as alerts. If a firm here does hold a licence under a different name, add it to `sponsor-aliases.yml` (firm: "Register Name Ltd").', '',
    `## Not found (${unmatched.length})`, '', ...unmatched.map(([f, v]) => `- ${f}${v.match !== 'none' ? ` (${v.match})` : ''}`), '',
    `## Matched automatically by close name; worth a glance (${fuzzy.length})`, '', ...fuzzy.map(([f, v]) => `- ${f} → ${v.register_name} (${v.match})`), '',
  ].join('\n'));
  console.log(`sponsors: ${firms.size} firms, ${firms.size - unmatched.length} licensed, ${unmatched.length} not found (see reports/sponsor-unmatched.md)`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) main().catch((e) => { console.error(`sponsors: ${e.message}; data/sponsors.json left unchanged`); process.exit(0); });
