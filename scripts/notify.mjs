#!/usr/bin/env node
/**
 * notify.mjs: send the roles a career-ops scan just found to Slack
 * (and, optionally, to your phone via ntfy.sh).
 *
 * Usage: node scripts/notify.mjs <scan receipt JSON> [pipeline.md]
 *
 * Environment:
 *   SLACK_WEBHOOK_URL  Slack incoming-webhook URL (optional)
 *   NTFY_TOPIC         ntfy.sh topic name for phone push alerts (optional)
 *   SEED_RUN=1         first run: record everything silently, send one summary
 *   SUPPRESS_FILE      file of company names (one per line) not to alert on
 *
 * The scan receipt (scan.mjs --json) lists the URLs added this run; the
 * matching lines in data/pipeline.md carry company, title, location and the
 * posted date, which is what the alert shows.
 */

import { readFileSync, existsSync } from 'node:fs';

const [receiptPath, pipelinePath = 'data/pipeline.md'] = process.argv.slice(2);
const SLACK = process.env.SLACK_WEBHOOK_URL?.trim();
const NTFY = process.env.NTFY_TOPIC?.trim();
const SEED = process.env.SEED_RUN === '1';
const SUPPRESS_FILE = process.env.SUPPRESS_FILE?.trim();
const MAX_PER_MESSAGE = 40;

/** Parse one `- [ ] url | company | title | location | comp | posted: … | note: …` line. */
export function parsePipelineLine(line) {
  const m = line.match(/^- \[[ x]\] (\S+)(.*)$/);
  if (!m) return null;
  const [, url, rest] = m;
  const cells = rest.split(' | ').map((s) => s.trim()).filter((s, i) => i > 0 || s !== '');
  if (cells[0] === '') cells.shift();
  const labeled = {};
  const positional = [];
  for (const c of cells) {
    const lm = c.match(/^(posted|note|trust):\s*(.*)$/);
    if (lm) labeled[lm[1]] = lm[2];
    else positional.push(c);
  }
  const [company = '', title = '', location = '', comp = ''] = positional;
  return { url, company, title, location, comp, posted: labeled.posted || '' };
}

export function rowsForUrls(pipelineText, urls) {
  const wanted = new Set(urls);
  const byUrl = new Map();
  for (const line of pipelineText.split('\n')) {
    const row = parsePipelineLine(line.trim());
    if (row && wanted.has(row.url) && !byUrl.has(row.url)) byUrl.set(row.url, row);
  }
  return urls.map((u) => byUrl.get(u) || { url: u, company: '', title: u, location: '', comp: '', posted: '' });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackBlocks(rows, header) {
  const lines = rows.map((r) => {
    const bits = [r.company && `*${esc(r.company)}*`, r.location && esc(r.location), r.posted && `posted ${esc(r.posted)}`, r.comp && esc(r.comp)].filter(Boolean);
    return `• <${r.url}|${esc(r.title || 'Open posting')}>\n   ${bits.join(' · ')}`;
  });
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: header.slice(0, 150) } }];
  // Slack section text is capped at 3000 characters.
  let chunk = '';
  for (const l of lines) {
    if ((chunk + l).length > 2800) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
      chunk = '';
    }
    chunk += `${l}\n`;
  }
  if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  return blocks;
}

async function postSlack(payload) {
  if (!SLACK) return;
  const res = await fetch(SLACK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) console.error(`Slack: HTTP ${res.status} ${await res.text()}`);
}

async function postNtfy(title, body, clickUrl) {
  if (!NTFY) return;
  const headers = { Title: title.replace(/[^\x20-\x7E]/g, ''), Tags: 'briefcase' };
  if (clickUrl) headers.Click = clickUrl;
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY)}`, { method: 'POST', headers, body });
  if (!res.ok) console.error(`ntfy: HTTP ${res.status}`);
}

async function main() {
  if (!receiptPath || !existsSync(receiptPath)) {
    console.error('notify: no scan receipt found; the scan step probably failed before writing one.');
    process.exit(0);
  }
  const raw = readFileSync(receiptPath, 'utf8').trim();
  let receipt;
  try {
    receipt = JSON.parse(raw.split('\n').filter((l) => l.startsWith('{')).pop() || '{}');
  } catch (err) {
    console.error(`notify: could not parse scan receipt: ${err.message}`);
    process.exit(0);
  }
  const urls = Array.isArray(receipt.added_urls) ? receipt.added_urls : [];
  const errors = Array.isArray(receipt.errors) ? receipt.errors : [];
  console.log(`scan: ${receipt.scanned ?? '?'} boards, ${receipt.found ?? '?'} postings seen, ${urls.length} new matches, ${errors.length} board errors`);

  if (!SLACK && !NTFY) {
    console.log('notify: no SLACK_WEBHOOK_URL or NTFY_TOPIC secret set; nothing sent.');
    return;
  }

  if (SEED) {
    const text = `Finance Job Radar is live. First scan indexed ${urls.length} matching roles across ${receipt.scanned ?? '?'} boards. From now on you will only be alerted about roles posted after this point.`;
    await postSlack({ text });
    await postNtfy('Finance Job Radar is live', text);
    return;
  }

  if (urls.length === 0) return;

  const pipelineText = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8') : '';
  let rows = rowsForUrls(pipelineText, urls);
  // Firms just added by the weekly discovery job: their already-open roles are
  // recorded but not alerted, so a new firm doesn't flood the channel.
  if (SUPPRESS_FILE && existsSync(SUPPRESS_FILE)) {
    const quiet = new Set(readFileSync(SUPPRESS_FILE, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean));
    const before = rows.length;
    rows = rows.filter((r) => !quiet.has(r.company.trim().toLowerCase()));
    if (before !== rows.length) console.log(`notify: ${before - rows.length} roles at newly added firms recorded without alerts`);
  }
  if (rows.length === 0) return;
  const time = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });

  for (let i = 0; i < rows.length; i += MAX_PER_MESSAGE) {
    const part = rows.slice(i, i + MAX_PER_MESSAGE);
    const header = `${rows.length} new finance role${rows.length === 1 ? '' : 's'} (${time} UK)${rows.length > MAX_PER_MESSAGE ? ` · part ${i / MAX_PER_MESSAGE + 1}` : ''}`;
    await postSlack({ text: header, blocks: slackBlocks(part, header) });
  }

  if (NTFY) {
    const first = rows[0];
    const body = rows.slice(0, 8).map((r) => `${r.company}: ${r.title}${r.location ? ` (${r.location})` : ''}`).join('\n')
      + (rows.length > 8 ? `\n+${rows.length - 8} more in Slack` : '');
    await postNtfy(`${rows.length} new finance role${rows.length === 1 ? '' : 's'}`, body, rows.length === 1 ? first.url : undefined);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) main().catch((err) => { console.error(err); process.exit(0); });
