# Atomic Authority

A self-hosted, Human-in-the-Loop LinkedIn content engine for the Nuclear/AI niche. Generates one post per day maximum, always requiring human approval before scheduling. Once approved, the scheduler publishes automatically at an optimal time.

## Stack

- Node.js v22+, TypeScript
- `@anthropic-ai/sdk` — all LLM calls (Claude Haiku + Opus)
- `playwright` — LinkedIn browser automation
- `node-cron` — scheduling
- Telegram bot — HITL notifications and approval flow

## How it works

### Content pipeline

```
RSS Feeds → Rank & score articles → Pick best → Fetch full article text
  → Generate hook → Synthesize draft → Verify facts → Screen for cringe
  → Save to pending → Telegram notification → Human approves → Scheduler posts
```

1. **Fetch** — pulls up to 50 articles (5 per feed) from 10 nuclear/energy RSS sources
2. **Rank** — Claude Haiku scores all eligible articles on nuclear/AI intersection, Canadian/NA relevance, recency, and freshness vs. recently posted topics. Hard-excludes articles already pending, approved, or rejected within the last 24 hours.
3. **Score** — each article gets a combined score: `article score × post-type balance multiplier × recency multiplier`. The balance multiplier steers toward underused post types. The recency multiplier rewards articles 0–1 days old (1.5×) and penalises older ones (down to 0.4× at 15+ days).
4. **Fetch full text** — the winning article's full body is fetched and passed to synthesis so Claude has specific facts, figures, and quotes to work with.
5. **Hook generation** — Claude Haiku generates up to 6 candidate opening lines across 2 rounds, scores each, and selects the best (target score ≥ 7). The chosen hook is injected as a hard constraint into the synthesis prompt.
6. **Synthesize** — Claude Opus writes the post draft using the full persona system prompt (post type, tone rules, banned phrases, required terminology, temporal language rules based on article age).
7. **Verify** — a separate Claude call checks the draft's factual claims against the full article text and corrects any inaccuracies before saving.
8. **Screen** — Claude Haiku acts as an editorial critic, scoring 1–10 on a cringe scale. Posts scoring >3, or containing contrasting reframe patterns ("That's not X. That's Y." / "Less X, more Y."), are auto-revised before saving.
9. **Mentions** — company and org names in the post are automatically wrapped in `[[MENTION:Name]]` markers using a verified dictionary. During posting, Playwright types `@searchTerm` in the LinkedIn composer and selects the first autocomplete result. Any new org names detected in the post are appended to the dictionary as unverified for future review.
10. **Notify** — Telegram bot sends the draft with source, feed name, combined score, and inline approve/reject buttons.
11. **Approve** — human reviews in Telegram; a posting time is automatically picked from optimal LinkedIn windows with random variance.
12. **Post** — the scheduler publishes to LinkedIn via Playwright at the scheduled time, resolving `[[MENTION:X]]` markers into real LinkedIn @mentions.

### Comment reply pipeline

```
Poll recent posts → Scrape new comments → Classify & generate 3 reply options
  → Screen for AI-isms → Telegram notification → Human selects & confirms → Post reply
```

1. **Poll** — checks LinkedIn posts published within the last 14 days for new comments. Weekday schedule: every 10 min (most recent post only) if a post is <2h old; full 14-day sweep every 3h otherwise. Weekend schedule: 8am and 8pm ET only.
2. **Filter** — skips comments already seen and any comment from your own account (`LINKEDIN_DISPLAY_NAME`).
3. **Classify** — Claude Haiku classifies each comment (question / agreement / pushback / adds-context / generic) and reasons about the commenter's intent.
4. **Generate** — produces 3 reply options with distinct approaches (agree, push-back, add-context, question, concede, reframe, direct), drawn from post content, article title, and thread context.
5. **Screen** — all 3 options are screened for AI-isms and banned phrases.
6. **Notify** — Telegram message shows the comment, AI reasoning, and 3 labeled options. The recommended option appears first with a 1-line justification (⭐).
7. **Approve** — two-step: select an option → preview text → confirm or go back. Skip is always available.
8. **Post** — Playwright opens the post, clicks Reply on the specific comment, preserves LinkedIn's @mention pre-fill, and types the reply at a natural speed.

### Outbound engagement pipeline

```
Poll curated profiles → Scrape original posts (<12h) → Score by relevance + recency + diversity
  → Generate 2 comment options → Screen for AI-isms → Telegram notification
  → Human selects & confirms → Post comment
```

1. **Profiles** — a curated list of LinkedIn profiles and company pages in `outbound_profiles.json`. Add a profile by sending its LinkedIn URL to the Telegram bot.
2. **Poll** — runs at 10am and 2pm ET on weekdays. Opens one shared browser context and visits each profile in sequence to minimise overhead. Profiles with no recent posts are checked less frequently (every 2nd or 3rd poll) to save time.
3. **Scrape** — fetches posts ≤12h old from each profile's activity feed. Reposts are filtered out by comparing the post author against the known profile name.
4. **Relevance gate** — each post is scored against a 100-keyword bank covering AI, nuclear, energy, regulation, and adjacent topics. Posts with zero keyword hits are discarded entirely.
5. **Rank** — all relevant candidates across all profiles are scored on three weighted factors:
   - **Relevance (50%)** — keyword hit count (0–5+ hits scaled to 0–1)
   - **Recency (30%)** — post age (0–12h scaled to 1–0)
   - **Profile diversity (20%)** — hours since last comment on that profile (0–48h+ scaled to 0–1)
   - Profile candidates receive a small score bonus (+0.1) over hashtag candidates
6. **Generate** — Claude Haiku generates a 1-sentence plain-English post summary, a 1-sentence engagement rationale, and 2 comment options with distinct approaches (add-context, ask-question, counterpoint, affirm-extend). Comments never cite specific numbers, stats, or studies not present in the original post.
7. **Persona** — profile flags adjust the comment voice:
   - `insider: true` — comments as a team member with internal knowledge (used for affiliated orgs)
   - `colleague: true` — suppresses contrarian/counterpoint approaches for direct colleagues
   - `stranger: true` — (hashtag-sourced posts) prefers ask-question/add-context over counterpoint
8. **Screen** — both comment options are screened for AI-isms.
9. **Notify** — Telegram message shows the profile name, post age (with ⚡ if <2h), keyword count, post snippet, plain-English summary, 1-sentence reason to engage, and 2 labeled options. Recommended option appears first (⭐).
10. **Skip** — skipping marks the post as seen (won't resurface) and serves the next best candidate. Skipping that ends the session.
11. **Post** — Playwright navigates to the post, clicks the comment box, and types at a natural speed.

### Analytics & reporting

- Metrics (reactions, comments, reposts) are scraped for all posts in the last 90 days via Playwright.
- Every Monday after the metrics fetch, a monthly report is sent to Telegram covering:
  - Total and avg engagement across the 30-day window
  - Post types ranked by avg engagement
  - Top 5 content tags by avg engagement
  - Top 5 hashtags by avg engagement
  - Source feeds ranked by avg engagement
  - Day of week ranked by avg engagement
  - Time window ranked by avg engagement (Morning / Noon / Evening / Other, ET)
  - Best individual post of the period

---

## Setup

### Windows

#### 1. Install Node.js v22+

Download and install from [nodejs.org](https://nodejs.org). Verify with:

```bash
node --version
```

#### 2. Clone the repo and install dependencies

```bash
git clone https://github.com/travismorton1995/atomic-authority-agent.git
cd atomic-authority-agent
npm install
npx playwright install chromium
```

#### 3. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
copy .env.example .env
```

#### 4. First-time LinkedIn session

Run the scheduler with a visible browser window to log into LinkedIn. The session is saved to `user_data/` and reused on all subsequent runs.

```bash
set LINKEDIN_HEADLESS=false && npm run scheduler
```

Once authenticated, set `LINKEDIN_HEADLESS=true` in your `.env` for background operation.

#### 5. Run persistently (hidden background process)

Use the included VBScript to run the scheduler silently with no visible terminal window:

```bash
wscript run-hidden.vbs
```

To auto-start on every login, create a file at:
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\atomic-authority.bat`

With the contents:
```bat
@echo off
wscript "C:\dev\atomic-authority-agent\run-hidden.vbs"
```

To check if the scheduler is running:
```bash
npm run status
```

To restart it after pulling code changes:
```bash
npm run restart-scheduler
```

---

### Raspberry Pi

Tested on Pi 4/5 with a 64-bit OS (Raspberry Pi OS Bookworm recommended). Pi 3 and 32-bit OS are not supported.

#### 1. Install Node.js v22+

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

#### 2. Clone the repo and install dependencies

```bash
git clone https://github.com/travismorton1995/atomic-authority-agent.git
cd atomic-authority-agent
npm install
npx playwright install chromium
npx playwright install-deps chromium
```

#### 3. Configure environment

```bash
cp .env.example .env
nano .env
```

#### 4. First-time LinkedIn session

The Pi runs headless, so you need to establish the LinkedIn session on a machine with a display first, then copy the session folder over.

**Option A — authenticate on a desktop machine first:**
1. Complete setup on a Windows machine (steps above)
2. Copy the `user_data/` folder from the Windows machine to the same path on the Pi
3. Set `LINKEDIN_HEADLESS=true` in `.env` on the Pi

**Option B — authenticate directly on the Pi via VNC:**
1. Enable VNC on the Pi (`sudo raspi-config` > Interface Options > VNC)
2. Connect via VNC Viewer from another machine
3. Run `LINKEDIN_HEADLESS=false npm run scheduler` inside the VNC session
4. Log into LinkedIn in the browser that opens
5. Once authenticated, set `LINKEDIN_HEADLESS=true` in `.env`

#### 5. Run persistently with pm2

```bash
sudo npm install -g pm2
pm2 start npm --name "atomic-authority" -- run scheduler
pm2 save
pm2 startup
```

Follow the printed command from `pm2 startup` to enable auto-start on reboot.

#### Pi notes

- Playwright/Chromium launches slowly on Pi — this is normal
- Make sure the Pi's system time is correct (`timedatectl status`) or set the timezone: `sudo timedatectl set-timezone America/Toronto`
- If Playwright fails to launch, run `npx playwright install-deps chromium` to install missing system libraries

## Usage

### Run the full scheduler (recommended)

```bash
npm run scheduler
```

Runs continuously. Generates a draft at 7:00pm ET on Monday, Tuesday, and Wednesday. Publishes approved posts automatically at a randomised time within the next optimal LinkedIn window.

### Generate a draft manually

```bash
# From RSS (ranks and picks the best article automatically)
npm run generate

# From a specific article URL
npm run generate -- --url https://example.com/article

# From a free-text topic (skips RSS entirely)
npm run generate -- --topic "your topic or observation"
```

### Review and approve pending posts

```bash
# List all pending posts
npm run approve

# Approve a specific post (schedules it automatically)
npm run approve -- --id <post_id>

# Reject a post
npm run reject -- --id <post_id>
```

### Post immediately

```bash
# Publish the oldest approved post right now (bypasses scheduled time)
npm run post-now

# Publish a specific post by ID (accepts pending or approved status)
npm run post-now -- --post_id=<post_id>
```

### Manage @mentions dictionary

```bash
npm run test-mentions
```

Opens a headed LinkedIn browser and walks through each unverified entry in the mentions dictionary. For each entry it types `@searchTerm` in the composer so you can visually confirm the correct company appears as the first autocomplete result.

Controls:
- `y` — mark as verified (will be @mentioned in future posts)
- `n` — skip for now
- `r` — remove from dictionary entirely (wrong result or no LinkedIn page)
- `q` — quit and save

New company/org names are automatically detected after each `generate` run and appended as unverified. Run `test-mentions` periodically to process the queue.

### Poll for comments manually

```bash
# Poll all posts from the last 14 days
npm run poll-comments

# Poll a specific post URL
npm run poll-comments -- https://www.linkedin.com/posts/...
```

### Trigger outbound engagement manually

```bash
npm run poll-outbound
```

Scrapes all profiles in `outbound_profiles.json`, scores posts by relevance/recency/diversity, generates comment options for the best match, and sends a Telegram notification.

### Fetch metrics and run monthly report

```bash
# Scrape metrics for all posts in the last 90 days and save to posted_history.json
npm run fetch-metrics
```

The monthly report is sent to Telegram automatically every Monday. To trigger it manually, run `npm run fetch-metrics` — the scheduler will fire the report after the fetch completes.

### Other commands

```bash
# Check if the background scheduler is running
npm run status

# Kill and relaunch the scheduler (use after pulling code changes)
npm run restart-scheduler

# Show all available commands
npm run help
```

## File structure

```
src/
  content/        # RSS fetcher, ranker, hook generator, synthesizer, verifier, screener, reply generator
  hitl/           # post queue, comment queue, outbound poll, Telegram bot and notifications
  scheduler/      # cron logic, time window picker, comment poll and outbound scheduling
  poster/         # LinkedIn browser automation (post, reply, outbound comment, @mentions)
  outbound/       # profile scraper, comment generator, relevance keyword bank, outbound queue state
  cli/            # generate / approve / reject / post-now / poll-comments / poll-outbound / fetch-metrics CLI commands
pending_posts.json      # active queue (pending and approved posts)
rejected_posts.json     # rejected posts (24-hour cooldown before re-selection)
posted_history.json     # archive of published posts with metrics
comment_state.json      # seen comment IDs, pending replies, last poll time (gitignored)
outbound_state.json     # seen post IDs, pending outbound comments, daily count (gitignored)
outbound_profiles.json  # curated list of profiles to monitor for outbound engagement
candidates.json         # ranked article candidate store
user_data/              # LinkedIn session persistence (gitignored)
.env                    # API keys and config (gitignored)
```

## Posting schedule

- **Max 1 post per day**
- **Preferred days:** Tuesday, Wednesday, Thursday
- **Time windows (Eastern):** 7:30–9:00am, 12:00–1:00pm, 5:00–6:30pm
- Random variance applied (±15 min) to avoid robotic patterns

## Post types

| Type | Weight | Description |
|---|---|---|
| bridge | 30% | Connect a regulatory/industry development to a concrete AI application |
| change-management | 20% | Human/org side of AI adoption in regulated industries |
| explainer | 15% | Translate a nuclear concept for an AI audience, or vice versa |
| contrarian | 15% | Challenge a mainstream AI assumption through the nuclear lens |
| myth-busting | 10% | Identify and dismantle a widespread misconception about nuclear or AI |
| hot-take | 8% | Short, pointed, designed for engagement |
| prediction | 7% | Time-bounded claim about where nuclear AI is heading in 12–24 months |

## Article scoring

Combined score = `article score (1–10) × balance multiplier × recency multiplier`

**Recency multipliers:**

| Article age | Multiplier |
|---|---|
| 0–1 days | 1.5× |
| 2–3 days | 1.0× |
| 4–7 days | 0.8× |
| 8–14 days | 0.6× |
| 15+ days | 0.4× |

The balance multiplier (0.25–2.0×) boosts post types that are underused relative to their target weight over the last 14 posts.

## RSS sources

| Source | URL |
|---|---|
| World Nuclear News | worldnuclearnews.org |
| Canadian Nuclear Association | cna.ca |
| CNSC | Canadian Nuclear Safety Commission API |
| ANS Newswire | ans.org |
| IAEA | iaea.org |
| Bruce Power | brucepower.com |
| NEI Magazine | neimagazine.com |
| Power Magazine | powermag.com (nuclear category) |
| Canadian Nuclear Society | cns-snc.ca |
| Canadian Nuclear Laboratories | cnl.ca |

## Rejection handling

Rejected posts are moved to `rejected_posts.json`. The pipeline applies two layers of exclusion:

- **24-hour URL/title cooldown** — the same article won't be re-selected for the next day's run
- **All-time post-type avoidance** — if an article was previously rejected, the ranker is instructed to suggest a different post type if it resurfaces

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token for HITL notifications and approval flow |
| `TELEGRAM_CHAT_ID` | Yes | Telegram chat ID to receive notifications |
| `LINKEDIN_HEADLESS` | No | Set to `true` for headless Playwright (default: `false`) |
| `LINKEDIN_DISPLAY_NAME` | No | Your LinkedIn display name — used to filter your own comments from reply polling |
