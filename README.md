# Atomic Authority

A self-hosted, Human-in-the-Loop LinkedIn content engine for the Nuclear/AI niche. Generates one post per day maximum, always requiring human approval before scheduling. Once approved, the scheduler publishes automatically at an optimal time.

## Stack

- Node.js v22+, TypeScript
- `@anthropic-ai/sdk` — all LLM calls (Claude)
- `playwright` — LinkedIn browser automation
- `node-cron` — scheduling
- Discord webhook — HITL notifications

## How it works

```
RSS Feeds → Rank articles → Pick best → Synthesize draft → Screen for cringe
     → Save to pending → Discord notification → Human approves → Scheduler posts
```

1. **Fetch** — pulls latest items from World Nuclear News, Canadian Nuclear Association, CNSC, and ANS Newswire
2. **Rank** — Claude Haiku scores all articles for nuclear/AI intersection, Canadian/NA relevance, and freshness vs recently posted topics. Hard-excludes articles already pending or approved.
3. **Synthesize** — Claude Opus writes a draft using the full persona system prompt (post type, tone rules, banned phrases, required terminology)
4. **Screen** — a second Claude Opus call acts as an editorial critic, scoring 1–10 on a "Cringe Scale". Posts scoring >3 are auto-revised before saving.
5. **Notify** — Discord webhook fires with the draft and approve/reject commands
6. **Approve** — human reviews and approves; a posting time is automatically picked from optimal LinkedIn windows
7. **Post** — the scheduler publishes to LinkedIn via Playwright at the scheduled time

## Setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### 3. First-time LinkedIn session

On first run, Playwright will open a visible browser window. Log into LinkedIn manually — the session is saved to `user_data/` and reused on all subsequent runs.

```bash
LINKEDIN_HEADLESS=false npm run scheduler
```

Once your session is established, set `LINKEDIN_HEADLESS=true` in `.env` for background operation.

## Usage

### Run the full scheduler (recommended)

```bash
npm run scheduler
```

Runs continuously. Generates a draft at a randomised time each weekday and publishes approved posts automatically.

### Generate a draft manually

```bash
npm run generate
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

## File structure

```
src/
  content/        # RSS fetcher, ranker, synthesis prompt, screener
  hitl/           # pending_posts.json manager, Discord notifier
  scheduler/      # cron logic, time window picker
  poster/         # LinkedIn browser automation (Playwright)
  cli/            # generate / approve / reject CLI commands
pending_posts.json      # active queue (pending, approved, rejected, published)
posted_history.json     # archive of approved and published posts
user_data/              # LinkedIn session persistence (gitignored)
.env                    # API keys and config (gitignored)
```

## Posting schedule

- **Max 1 post per day**
- **Preferred days:** Tuesday, Wednesday, Thursday
- **Time windows (Eastern):** 7:30–9:00am, 12:00–1:00pm, 5:00–6:30pm
- Random variance applied to avoid robotic patterns

## Post types

| Type | Weight | Description |
|---|---|---|
| bridge | 30% | Connect a regulatory/industry development to a concrete AI application |
| contrarian | 25% | Challenge a mainstream AI assumption through the nuclear lens |
| change-management | 20% | Human/org side of AI adoption in regulated industries |
| explainer | 15% | Translate a nuclear concept for an AI audience, or vice versa |
| hot-take | 10% | Short, pointed, designed for engagement |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `DISCORD_WEBHOOK_URL` | No | Discord webhook for HITL notifications (falls back to console) |
| `LINKEDIN_HEADLESS` | No | Set to `true` for headless Playwright (default: `false`) |
