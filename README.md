# Finance Job Radar

Checks ~300 UK finance employers' own careers sites every hour and sends you
new junior finance roles (Slack and/or a phone notification) usually within
about an hour of them going live.

It runs on GitHub Actions, so it keeps going while your laptop is off, and it
costs no AI tokens: the scanning is done by [career-ops](https://github.com/career-ops-hq/career-ops)'s
zero-token scanner (pinned to release `career-ops-v1.38.0`).

## What's in here

| File | What it does |
|---|---|
| `portals.yml` | The ~140 boards scanned every hour (~125 firms: banks, IB boutiques, asset managers, PE/hedge funds, trading firms, insurers, Big 4, fintechs, FTSE corporates), plus the title, seniority, UK-location and visa filters |
| `companies.yml` | ~200 more firms. The weekly discovery job finds their hiring boards and adds them to `portals.yml` |
| `.github/workflows/scan.yml` | Hourly scan → alerts |
| `.github/workflows/discover.yml` | Weekly: adds boards for firms in `companies.yml`, tests every board, writes `reports/discovery.md` |
| `scripts/notify.mjs` | Sends the Slack / phone alerts |
| `scripts/find-ats.mjs` | Finds a firm's hiring system by reading its careers pages |

## Setup (about 15 minutes)

### 1. Make the repository

1. On GitHub, create a new repository called `finance-job-radar`.
   **Make it public.** Public repos get unlimited free Actions minutes; a
   private one gets 2,000 minutes a month, and an hourly scan uses more than
   that. Nothing personal goes in this repo: only company names, job links
   and the scan history.
2. Upload every file from this folder, keeping the folder structure
   (including the hidden `.github` folder). Easiest from Terminal:

   ```bash
   cd ~/Downloads/finance-job-radar
   git init -b main && git add . && git commit -m "Finance Job Radar"
   git remote add origin https://github.com/<your-username>/finance-job-radar.git
   git push -u origin main
   ```

3. In the repo, go to **Settings → Actions → General → Workflow permissions**,
   choose **Read and write permissions**, and save. The scan needs this to
   remember which jobs it has already shown you.

### 2. Choose where alerts go (one or both)

**Slack**
1. Go to <https://api.slack.com/apps> → **Create New App** → *From scratch*,
   pick your workspace.
2. **Incoming Webhooks** → turn on → **Add New Webhook to Workspace** → pick a
   channel (e.g. `#job-alerts`) → copy the URL.
3. In the GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**. Name `SLACK_WEBHOOK_URL`, value the URL.

**Phone push (ntfy, free, no account)**
1. Install the **ntfy** app (iOS / Android).
2. Subscribe to a topic with a long random name nobody would guess,
   e.g. `manpreet-radar-7f3k9q2x`.
3. Add a repository secret named `NTFY_TOPIC` with that topic name.

### 3. Start it

1. **Actions** tab → enable workflows if asked.
2. Run **Finance job scan** once by hand (*Run workflow*). The first run
   records every role already open and sends a single "Radar is live"
   message, so you are not flooded with hundreds of old postings. Check the
   message arrives.
3. Run **Find more company boards** once by hand. It takes 10-30 minutes,
   grows `portals.yml` towards ~300 firms, and records the roles already open
   at the newly added firms without alerting you. It then repeats every
   Monday; `reports/discovery.md` shows what it added and which firms it
   couldn't scan.

From then on the scan runs at 17 minutes past every hour and only alerts you
about roles that are new since the last run.

## Tuning

- **Roles:** edit `title_filter` in `portals.yml`. A title needs one
  `positive` keyword and no `negative` one; Senior/Lead/VP/Director/Head of
  are dropped automatically. If you want Data Analyst roles gone, add
  `"Data Analyst"` to `negative`.
- **India:** delete `"India"` from the location `block` list and add the
  cities you want to `allow`.
- **More firms:** add a line to `companies.yml` (name + website), then run
  the discovery workflow.
- **Faster than hourly:** GitHub's minimum is every 5 minutes, but hourly is
  plenty for most boards and keeps you well inside fair use.

## Limits worth knowing

- **Latency:** GitHub sometimes starts scheduled runs 5-20 minutes late, so
  expect alerts roughly 1-1.5 hours after a role is posted, not instantly.
- **Not every firm can be scanned.** Some big employers (e.g. Goldman Sachs,
  McKinsey, BCG, Bain) run custom careers sites the scanner cannot read.
  `reports/discovery.md` lists them each week: set job alerts on their own
  sites for those.
- **Sponsorship:** the visa filter only drops roles whose description says
  "no sponsorship". Workday lists don't include descriptions, so check
  sponsorship yourself on anything you apply to.
- **Job boards:** this watches employers' own sites only. Keep LinkedIn and
  eFinancialCareers alerts (or your Apify scraper) running for recruiter
  posts and firms not on the list.

## Using it with career-ops on your Mac

When an alert looks good, open career-ops in the Claude desktop app and paste
the link. It will score the fit and tailor your CV and cover letter.
