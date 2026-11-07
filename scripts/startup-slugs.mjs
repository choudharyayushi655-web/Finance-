#!/usr/bin/env node
// Finds the job-board slug for startups whose slug is wrong or unknown.
// Tries name variants on Greenhouse, Ashby, Lever (global + EU) and Workable,
// and writes reports/startup-slugs.md with a ready-to-paste YAML line for each
// hit. Run from the "Check startup list" workflow. Records nothing.
//
//   node scripts/startup-slugs.mjs --engine <career-ops dir> [--names "A,B,C"]
//
// Names checked: every company in companies_startups.yaml whose slug fails,
// plus the CANDIDATES below, minus firms already tracked in portals.yml.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
const ENGINE = arg('--engine') || process.env.CAREER_OPS_ENGINE;
const ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
const { loadYaml } = await import(pathToFileURL(join(ENGINE, 'lib/yaml-document.mjs')).href);

// UK startups/scale-ups/SMEs with finance teams. Add names freely.
const CANDIDATES = `iwoca, Kriya, Paysend, Soldo, Curve, PrimaryBid, Wayflyer, Griffin, Silverfin, Chatham Financial,
MoonPay, Banked, Moneyhub, Codat, Ravelin, Habito, Flagstone, Tymit, Juni, Mintago, Wealthify, Nutmeg, OpenPayd,
Spendesk, Ledger, Tradeshift, PayFit, Yapily, Lightyear, Pockit, Uncapped, Bink, Yonder, Bud, Ember, Fuse Energy,
Kroo, Ophelos, Cleo, Fintern, Hoxton Wealth, Kuflink, Sedgwick, Allica Bank, OakNorth, Atom bank, Chip, Plum,
Freetrade, Trading 212, Lendable, Marshmallow, Cuvva, Zilch, Ebury, Paddle, Primer, TrueLayer, Form3, Modulr,
ClearBank, Thought Machine, ClearScore, Funding Circle, Tide, GoCardless, Starling Bank, Zopa, Wise, Checkout.com,
Onfido, Quantexa, Tractable, Cera, Multiverse, Beamery, Pleo, Ramp, Payoneer, Airwallex, Rapyd, Nium, Thunes,
Volt, Tink, Bloom Money, Abound, Fronted, Hometree, Bricks, Moneyfarm, Scalable Capital, Shares, Stake, Wombat,
Kroll Bond, LendInvest, Molo, Perenna, Kroo Bank, Unmortgage, Landbay, Proportunity, Ziglu, Bitpanda, Copper,
Komainu, Zodia Custody, Archax, Fnality, Baton Systems, Duco, Cobalt, OpenGamma, Clear Treasury, Kyriba, Previse,
Fluidly, Float, Tunic Pay, Satago, Capitalise, Swoop Funding, Nucleus Commercial Finance, MarketFinance, Ultimate Finance,
Boost Capital, YouLend, Liberis, 365 Finance, Ezbob, Penfold, Smart Pension, PensionBee, Cushon, Moneybox, Chase UK,
Kraken, Blockchain.com, Paxos, Bitstamp, Gemini, CMC Markets, IG Group, Plus500, Capital.com, Pepperstone, Saxo,
Interactive Investor, AJ Bell, Hargreaves Lansdown, Seccl, WealthKernel, Bestinvest, Octopus Energy, Ovo, Bulb,
Ohme, Zapp, Pod Point, Deliveroo, Gousto, HelloFresh, Depop, Vinted, Cazoo, Motorway, Carwow, Zego, Laka, Superscript,
Flock, Bought By Many, Lemonade, Wefox, Collective Benefits, Hokodo, Sonovate, Previse, Paysafe, Worldpay, Nuvei,
SumUp, Dojo, Teya, Yoco, Square, Lightspeed, Planday, Deputy, Personio, HiBob, Remote, Deel, Rippling, Oyster,
Papaya Global, Payhawk, Pliant, Moss, Qonto, Mollie, Adyen, Vyne, Token.io, Nuapay, Ecospend, Crezco, Bankifi`
  .split(',').map((s) => s.trim()).filter(Boolean);

const UA = 'finance-job-radar (slug finder)';
const norm = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function variants(name) {
  const n = norm(name.replace(/\.com\b/i, ''));
  const words = n.split(' ');
  const base = [...new Set([words.join(''), words.join('-'), words[0]])].filter((v) => v.length >= 2);
  const out = new Set(base);
  for (const b of base.slice(0, 2)) for (const suf of ['hq', 'uk', 'ltd', 'careers', 'jobs', 'group', 'app', 'io', 'technologies']) out.add(b + suf);
  out.add(n.replace(/\.com/, 'com').replace(/ /g, ''));
  return [...out].slice(0, 14);
}

const PROBES = [
  ['greenhouse', (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, (j) => j?.jobs, (j) => j.location?.name],
  ['ashby', (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, (j) => j?.jobs, (j) => [j.location, j.address?.postalAddress?.addressCountry].join(' ')],
  ['lever', (s) => `https://api.lever.co/v0/postings/${s}?mode=json`, (j) => (Array.isArray(j) ? j : null), (j) => j.categories?.location],
  ['lever-eu', (s) => `https://api.eu.lever.co/v0/postings/${s}?mode=json`, (j) => (Array.isArray(j) ? j : null), (j) => j.categories?.location],
  ['workable', (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}`, (j) => (j?.name ? j.jobs || [] : null), (j) => [j.city, j.country].join(' ')],
];
const UK = /\b(uk|united kingdom|england|scotland|wales|london|manchester|edinburgh|glasgow|birmingham|leeds|bristol|cardiff|belfast|cambridge|oxford|remote)\b/i;

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function find(name) {
  for (const slug of variants(name)) {
    for (const [ats, url, list, loc] of PROBES) {
      const json = await get(url(slug));
      const jobs = json && list(json);
      if (!jobs || !jobs.length) continue; // empty boards aren't worth adding (and some APIs answer 200 for anything)
      return { name, ats, slug, jobs: jobs.length, uk: jobs.filter((j) => UK.test(String(loc(j) || ''))).length };
    }
  }
  return { name, ats: null };
}

const listed = loadYaml(readFileSync(join(ROOT, 'companies_startups.yaml'), 'utf8'))?.companies || [];
const tracked = new Set((loadYaml(readFileSync(join(ROOT, 'portals.yml'), 'utf8'))?.tracked_companies || []).map((c) => norm(c.name)));
const working = new Set();
try {
  for (const line of readFileSync(join(ROOT, 'reports/startups-check.md'), 'utf8').split('\n')) {
    const m = line.match(/^\| (.+?) \| \w+ \/ \S+ \| ok \| (\d+)/);
    if (m && Number(m[2]) > 0) working.add(norm(m[1]));
  }
} catch {}
const extra = arg('--names') ? arg('--names').split(',').map((s) => s.trim()) : [];
const names = [...new Set([...listed.map((c) => c.name.replace(/ Workable$/, '')), ...CANDIDATES, ...extra])]
  .filter((n) => !tracked.has(norm(n)) && !working.has(norm(n)));

const results = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (i < names.length) { const n = names[i++]; results.push(await find(n)); } }));
results.sort((a, b) => (b.uk || -1) - (a.uk || -1) || a.name.localeCompare(b.name));

const hits = results.filter((r) => r.ats);
const lines = [
  '# Startup slug finder', '',
  `Tried ${names.length} names on Greenhouse, Ashby, Lever and Workable. Found ${hits.length}.`,
  'Copy the lines you want into companies_startups.yaml. Check the company is the right one (same-name firms exist).', '',
  '| Company | Found on | UK jobs / all | YAML line |', '|---|---|---|---|',
  ...hits.map((r) => {
    const ats = r.ats === 'lever-eu' ? 'lever' : r.ats;
    const region = r.ats === 'lever-eu' ? ', region: eu' : '';
    return `| ${r.name} | ${r.ats} / ${r.slug} | ${r.uk} / ${r.jobs} | \`- { name: ${r.name}, ats: ${ats}, slug: ${r.slug}${region} }\` |`;
  }),
  '', '## Not found on any of the four', '',
  results.filter((r) => !r.ats).map((r) => r.name).sort().join(', ') || '(none)', '',
];
mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'reports/startup-slugs.md'), lines.join('\n'));
console.log(`startup-slugs: ${names.length} names tried, ${hits.length} found`);
