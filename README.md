# Atomic Authority

A self-hosted, Human-in-the-Loop LinkedIn content engine for the Nuclear/AI niche. Generates one post per day maximum, always requiring human approval before scheduling. Once approved, the scheduler publishes automatically at an optimal time.

## Stack

- Node.js v22+, TypeScript
- `@anthropic-ai/sdk` — all LLM calls (Claude Haiku + Opus)
- `playwright` — LinkedIn browser automation
- `node-cron` — scheduling
- Telegram bot (Telegraf) — HITL notifications and approval flow
- Cloudflare Workers AI — AI image generation (optional)
- NewsData.io — supplementary news coverage (optional)

## How it works

### Content pipeline

```
RSS + NewsData → Rank & score articles → Pick best → Fetch full article
  → Generate hook (<140 chars) → Synthesize draft → Verify facts → Screen for AI-isms
  → Tag content → Generate AI image → Save to pending → Telegram notification
  → Human approves (choose image) → Scheduler posts at optimal time
```

1. **Fetch** — pulls up to 10 articles per feed from 11 nuclear/energy RSS sources, filtered to articles less than 5 days old. NewsData.io supplements with 5 curated keyword queries.
2. **Rank** — Claude Haiku scores all articles on a 4-dimension rubric: nuclear/AI intersection (0-4), novelty (0-3), geographic relevance (0-2), and NPX mention (0-1). Also suggests a post type and content tags.
3. **Score** — combined score = `article score x balance multiplier x recency multiplier x post-content feedback`. Balance steers toward underused post types. Recency rewards fresh articles. Post-content feedback boosts articles whose tags historically drive audience growth (composite score).
4. **Fetch full text** — downloads article body and og:image. HTML entities in URLs are decoded.
5. **Hook generation** — Claude Haiku generates 3 candidate opening lines per round (up to 2 rounds). Hard constraint: hooks must be under 140 characters (mobile "See More" truncation point). Hooks over 140 chars are rejected regardless of score.
6. **Synthesize** — Claude Opus writes the draft using the full persona prompt (post type instructions, tone rules, 30+ banned AI-ism phrases, 2:1 paragraph rhythm, anchor keyword rule, financial disclaimer, temporal language rules). Hashtag selection is guided by historical performance data. Target: 150-170 words.
7. **Verify** — a separate Claude call checks factual claims against the full article text and corrects inaccuracies.
8. **Screen** — Claude Opus scores 1-10 on a cringe scale. Posts scoring >3, or containing contrasting reframe patterns, are auto-revised. Also checks hook quality, paragraph length, em dashes, hashtag count, and first comment format.
9. **Content tags** — Claude Haiku assigns tags from a 30+ tag bank. Tags feed the composite score feedback loop.
10. **Mentions** — company/org names are wrapped in `[[MENTION:Name]]` markers using a verified dictionary. During posting, Playwright resolves these via LinkedIn's @mention autocomplete.
11. **AI image generation** — Claude Haiku converts post content into a photorealistic image prompt with post-type-specific visual direction and anti-AI-art rules. Cloudflare Workers AI (FLUX.2 Dev for first image of the day, FLUX.1 Schnell after) generates a 1200x672 PNG.
12. **Notify** — Telegram sends the draft with score breakdown, og:image preview, AI image preview, and inline buttons: Approve (article image), Approve (AI image), Approve (no image), Rewrite, Reject, Cancel.
13. **Post** — the scheduler publishes via Playwright at the scheduled time, attaching the chosen image via clipboard paste and resolving @mention markers.
14. **First comment** — posted immediately after: "Sourced from [Source]. [Simple question under 20 words]" followed by the article URL.

### Comment reply pipeline

```
Poll recent posts → Scrape new comments → Classify & generate 3 reply options
  → Screen for AI-isms → Telegram notification → Human selects & confirms → Post reply
```

1. **Poll** — checks posts from the last 14 days. Frequency adapts to post age: every 5 min in the first hour after posting (critical engagement window), every 10 min for hours 1-2, full sweep every 3 hours otherwise. Weekends: 8am and 8pm ET only.
2. **Filter** — skips already-seen comments and your own comments.
3. **Classify** — Claude Haiku classifies each comment (question / agreement / pushback / adds-context / generic).
4. **Generate** — 3 reply options with distinct approaches. Each is 1 sentence only.
5. **Screen** — all options screened for AI-isms, validation phrases, banned patterns.
6. **Notify** — Telegram shows the comment, AI reasoning, 3 labeled options with recommended first.
7. **Approve** — two-step: select option, preview, confirm or go back.
8. **Post** — Playwright opens the post, clicks Reply on the specific comment, types at natural speed.

### Outbound engagement pipeline

```
Rank profiles by priority → Scrape posts (<12h) within 2-min time limit
  → Score by relevance + recency + cooldown → Generate 2 comment options
  → Screen → Telegram notification → Human selects & confirms → Post comment
```

1. **Profiles** — curated list in `outbound_profiles.json`. Add profiles by sending a LinkedIn profile URL to the Telegram bot. Flags: `insider` (affiliated org), `colleague` (direct colleague).
2. **Priority ranking** — profiles sorted by: hours since last checked + frequency bonus (recent posters score higher) - comment cooldown penalty (commented in last 24h deprioritized). All profiles eventually get checked via round-robin.
3. **Time-bounded polling** — runs at 10am and 2pm ET weekdays. Scrapes as many profiles as fit within a 2-minute window, in priority order. Deferred profiles get highest priority next poll.
4. **Relevance scoring** — posts scored against a 100-keyword bank. Weighted: 50% relevance, 30% recency, 20% profile diversity.
5. **Comment cooldown** — hard 24-hour cooldown per profile. Won't queue a comment for any profile commented on within 24 hours.
6. **Generate** — 2 comment options. Default approaches: affirm-extend, add-context, support. Ask-question and counterpoint reserved for controversial/outlandish claims.
7. **Ad-hoc comments** — send any LinkedIn post URL to the Telegram bot to generate comment options on demand. Tracks the profile and marks the post as seen for future polls.

### Metrics & analytics

```
Scrape LinkedIn analytics pages → Extract impressions, engagement, followers
  → Compute composite performance score → Update feedback loops → Weekly report
```

1. **Per-post analytics** — scrapes `/analytics/post-summary/{urn}/` for each post. Captures: impressions, members reached, reactions, comments, reposts, saves, sends, new followers.
2. **Composite score** — weighted metric that values audience growth:
   ```
   newFollowers x 10 + reposts x 5 + sends x 5 + comments x 3
   + saves x 3 + reactions x 1 + impressions x 0.01
   ```
3. **Feedback loops** — composite scores feed back into the pipeline:
   - Content tags with historically high scores boost future article ranking (1.0-1.25x multiplier)
   - Hashtag performance guides Claude's hashtag selection (above/below average guidance)
4. **Weekly report** (Mondays via Telegram) — posts published, total impressions, engagement rate, saves, new followers, avg composite score. Rankings by: post type, content tags, hashtags, source feeds, day of week, time window. Best post with score and impressions.

## Telegram bot

### Commands

| Command | Description |
|---|---|
| `/generate` | Run the content pipeline and generate a new draft |
| `/poll` | Run a comment reply poll |
| `/outbound` | Run the outbound engagement poll |
| `/metrics` | Fetch engagement metrics and send weekly report |
| `/login` | Open a browser to renew your LinkedIn session |
| `/help` | Show all commands |

### URL actions

- **Send a LinkedIn profile URL** — adds the profile to the outbound tracking list
- **Send a LinkedIn post URL** — scrapes the post and generates comment options on demand

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

# Approve with image choice
npm run approve -- --id <post_id> --image ai|og|none

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

Opens a headed LinkedIn browser and walks through each unverified entry in the mentions dictionary. Controls: `y` (verify), `n` (skip), `r` (remove), `q` (quit and save).

### Other commands

```bash
npm run poll-comments           # Manually trigger comment polling
npm run poll-outbound           # Manually trigger outbound engagement polling
npm run fetch-metrics           # Scrape metrics for all posts (last 90 days)
npm run status                  # Check if the background scheduler is running
npm run restart-scheduler       # Kill and relaunch the scheduler
npm run logs                    # Tail the scheduler log
npm run help                    # Show all available commands
```

## Scheduling

### Content generation
- **7:00pm ET, Mon/Tue/Wed** — generates a draft for review

### Post publishing
- **Max 1 post per day**
- **Preferred days:** Tuesday, Wednesday, Thursday
- **Time windows (ET):** 7:30-9:00am, 12:00-1:00pm, 5:00-6:30pm
- Random variance (±15 min) to avoid robotic patterns

### Comment polling (weekdays)
- First hour after posting: every 5 min
- Hours 1-2: every 10 min
- Quiet periods: full sweep every 3 hours
- Weekends: 8am and 8pm ET only

### Outbound engagement
- Weekdays at 10am and 2pm ET
- Time-bounded to 2 minutes per poll

### Daily maintenance (8am ET)
- LinkedIn session health check
- Metrics fetch (last 90 days)
- Rejected post cleanup (older than 90 days)
- Weekly report (Mondays only)

## Post types

| Type | Weight | Description |
|---|---|---|
| bridge | 30% | Connect a regulatory/industry development to a concrete AI application |
| change-management | 20% | Human/org side of AI adoption in regulated industries |
| explainer | 15% | Translate a nuclear concept for an AI audience, or vice versa |
| contrarian | 15% | Challenge a mainstream AI assumption through the nuclear lens |
| myth-busting | 10% | Identify and dismantle a widespread misconception |
| hot-take | 8% | Short, pointed, designed for engagement |
| prediction | 7% | Time-bounded claim with natural timeline variance |

## Article scoring

Combined score = `article score (1-10) x balance multiplier x recency multiplier x post-content feedback`

| Factor | Range | Description |
|---|---|---|
| Article score | 1-10 | Nuclear/AI intersection + novelty + geography + NPX |
| Balance multiplier | 0.8-1.2x | Boosts underused post types |
| Recency multiplier | 0.4-1.3x | 0-1 days = 1.3x, 15+ days = 0.4x |
| Post-content feedback | 1.0-1.25x | Bonus for tags that historically drive audience growth |

## RSS sources

| Source | URL |
|---|---|
| World Nuclear News | worldnuclearnews.org |
| Canadian Nuclear Association | cna.ca |
| CNSC | Canadian Nuclear Safety Commission API |
| ANS Newswire | ans.org |
| IAEA | iaea.org |
| Bruce Power | brucepower.com |
| Power Magazine | powermag.com (nuclear category) |
| Canadian Nuclear Society | cns-snc.ca |
| Canadian Nuclear Laboratories | cnl.ca |
| Utility Dive | utilitydive.com |
| Power Engineering | power-eng.com |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Yes | Telegram chat ID |
| `LINKEDIN_HEADLESS` | No | `true` for headless Playwright (default: `false`) |
| `LINKEDIN_PROFILE_URL` | No | Your LinkedIn profile URL (for first-comment posting) |
| `LINKEDIN_DISPLAY_NAME` | No | Your LinkedIn name (filters own comments from reply polling) |
| `NEWSDATA_API_KEY` | No | NewsData.io API key (supplements RSS) |
| `CLOUDFLARE_ACCOUNT_ID` | No | Cloudflare account ID (for AI image generation) |
| `CLOUDFLARE_API_TOKEN` | No | Cloudflare Workers AI token (for AI image generation) |

## File structure

```
src/
  content/        # RSS, NewsData, ranker, hooks, synthesizer, verifier, screener,
                  #   image generator, reply generator, persona
  hitl/           # post queue, comment queue, outbound poll, Telegram bot
  scheduler/      # cron logic, time window picker
  poster/         # LinkedIn automation (post, reply, outbound comment, @mentions)
  outbound/       # profile scraper, single-post scraper, comment generator,
                  #   relevance keywords, outbound queue state
  cli/            # generate, approve, reject, post-now, poll-comments,
                  #   poll-outbound, fetch-metrics CLI commands
pending_posts.json      # active queue (pending and approved posts)
rejected_posts.json     # rejected posts (24-hour cooldown)
posted_history.json     # published posts with metrics and composite scores
comment_state.json      # seen comment IDs, pending replies, last poll time
outbound_state.json     # seen post IDs, pending outbound comments, daily count
outbound_profiles.json  # curated profiles for outbound engagement
candidates.json         # ranked article candidates (24h TTL)
generated_images/       # AI-generated post images
user_data/              # LinkedIn session persistence (gitignored)
.env                    # API keys and config (gitignored)
```
