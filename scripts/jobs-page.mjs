#!/usr/bin/env node
/**
 * jobs-page.mjs: turn data/pipeline.md into JOBS.md, a readable list of every
 * matched role (newest first, grouped by role type) that renders nicely on
 * GitHub, including the GitHub mobile app.
 *
 * Rows are re-checked against the CURRENT title filter in portals.yml, so
 * tightening the filter also cleans up roles that were matched earlier.
 *
 * Usage: node scripts/jobs-page.mjs --engine <career-ops dir> [--out JOBS.md]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePipelineLine } from './notify.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const ENGINE = path.resolve(opt('--engine', '../career-ops'));
const OUT = opt('--out', 'JOBS.md');
const PIPELINE = opt('--pipeline', 'data/pipeline.md');
const HISTORY = opt('--history', 'data/scan-history.tsv');

const CATEGORIES = [
  ['Investment banking & advisory', /investment banking|m&a|mergers|corporate finance|transaction services|deal|advisory|valuation|restructuring|capital markets|leveraged finance|structured finance|corporate banking/i],
  ['Credit', /credit/i],
  ['Risk', /risk|underwriting/i],
  ['FP&A, finance & accounting', /fp&a|financial planning|financial analyst|finance analyst|finance associate|finance business partner|commercial finance|commercial analyst|pricing analyst|accountant|accounting|financial reporting|product control|treasury|financial controller|finance transformation/i],
  ['Research, trading & quant', /research|trader|trading|quant/i],
  ['Asset & wealth management, private markets', /investment|asset management|portfolio|fund|private equity|private credit|private markets/i],
  ['Consulting & strategy', /consult|strategy/i],
  ['Graduate programmes', /graduate|programme|program/i],
];
const categoryOf = (title) => (CATEGORIES.find(([, rx]) => rx.test(title)) || ['Other'])[0];

/** First-seen date per URL from scan-history.tsv (fallback when a board gives no posted date). */
function firstSeen() {
  const map = new Map();
  if (!existsSync(HISTORY)) return map;
  const [header, ...rows] = readFileSync(HISTORY, 'utf8').split('\n');
  const cols = header.split('\t');
  const iu = cols.indexOf('url');
  const id = cols.findIndex((c) => /first_seen|date/.test(c));
  for (const r of rows) {
    const c = r.split('\t');
    if (c[iu] && c[id] && !map.has(c[iu])) map.set(c[iu], c[id].slice(0, 10));
  }
  return map;
}

const cell = (s) => String(s || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

async function main() {
  const { buildTitleFilter } = await import(pathToFileURL(path.join(ENGINE, 'title-keywords.mjs')).href);
  const { classifyTier } = await import(pathToFileURL(path.join(ENGINE, 'classify-tier.mjs')).href);
  const { loadYaml } = await import(pathToFileURL(path.join(ENGINE, 'lib/yaml-document.mjs')).href);
  const cfg = loadYaml(readFileSync('portals.yml', 'utf8')) || {};
  const titleOk = buildTitleFilter(cfg.title_filter);
  const skip = new Set(cfg.skip_tiers || []);

  const seen = firstSeen();
  const rows = [];
  const urls = new Set();
  for (const line of (existsSync(PIPELINE) ? readFileSync(PIPELINE, 'utf8') : '').split('\n')) {
    const r = parsePipelineLine(line.trim());
    if (!r || urls.has(r.url)) continue;
    urls.add(r.url);
    if (!titleOk(r.title) || skip.has(classifyTier(r.title))) continue;
    // Only the board's own posted date counts as "posted"; first-seen is used for
    // sorting undated roles but never shown as a posting date.
    const date = r.posted || '';
    rows.push({ ...r, date, seenAt: seen.get(r.url) || '', cat: categoryOf(r.title) });
  }
  rows.sort((a, b) => (b.date || b.seenAt || '').localeCompare(a.date || a.seenAt || '') || a.company.localeCompare(b.company));

  const now = new Date();
  const dayAgo = new Date(now - 36 * 3600 * 1000).toISOString().slice(0, 10);
  // New = posted in the last ~36h, or (for boards with no dates) first found
  // by the radar in that window after the starting scan.
  const starting = [...seen.values()].sort()[0] || '';
  const recent = rows.filter((r) => (r.date && r.date >= dayAgo) || (!r.date && r.seenAt && r.seenAt > starting && r.seenAt >= dayAgo));
  const table = (list) => [
    '| Posted | Role | Firm | Location |',
    '|---|---|---|---|',
    ...list.map((r) => `| ${r.date || '—'} | [${cell(r.title)}](${r.url}) | ${cell(r.company)} | ${cell(r.location).slice(0, 60)} |`),
  ].join('\n');

  const counts = CATEGORIES.map(([n]) => n).concat('Other')
    .map((n) => [n, rows.filter((r) => r.cat === n)]).filter(([, l]) => l.length);

  const out = [
    '# Finance jobs found',
    '',
    `Updated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC · **${rows.length} roles** matching your filters across ${new Set(rows.map((r) => r.company)).size} firms.`,
    '',
    'Click a role to open the posting. Check visa sponsorship on each one before applying.',
    '',
    '**Jump to:** ' + ['New (last day or so)', ...counts.map(([n]) => n)].map((n) => `[${n}](#${n.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')})`).join(' · '),
    '',
    `## New (last day or so)`,
    '',
    recent.length ? table(recent) : '_Nothing new in the last day._',
    '',
    ...counts.flatMap(([n, l]) => [`## ${n}`, '', `${l.length} roles`, '', table(l), '']),
  ].join('\n');
  writeFileSync(OUT, out, 'utf8');
  console.log(`jobs-page: ${rows.length} roles written to ${OUT} (${recent.length} new)`);
}

main().catch((e) => { console.error(e); process.exit(0); });
