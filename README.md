# Atomic Authority

A self-hosted, Human-in-the-Loop LinkedIn content engine for the Nuclear/AI niche. Generates one post per day maximum, always requiring human approval before scheduling. Once approved, the scheduler publishes automatically at an optimal time.

## Stack

- Node.js v22+, TypeScript
- `@anthropic-ai/sdk` — all LLM calls (Claude)
- `playwright` — LinkedIn browser automation
- `node-cron` — scheduling
- Telegram bot — HITL notifications and approval flow

## How it works

```
RSS Feeds → Rank articles → Pick best → Synthesize draft → Screen for cringe
     → Save to pending → Telegram notification → Human approves → Scheduler posts
```

1. **Fetch** — pulls latest items from World Nuclear News, Canadian Nuclear Association, CNSC, and ANS Newswire
2. **Rank** — Claude Haiku scores all articles for nuclear/AI intersection, Canadian/NA relevance, and freshness vs recently posted topics. Hard-excludes articles already pending or approved.
3. **Synthesize** — Claude Sonnet writes a draft using the full persona system prompt (post type, tone rules, banned phrases, required terminology)
4. **Screen** — a second Claude call acts as an editorial critic, scoring 1–10 on a "Cringe Scale". Posts scoring >3 are auto-revised before saving.
5. **Notify** — Telegram bot sends the draft with inline approve/reject buttons
6. **Approve** — human reviews and approves via Telegram; a posting time is automatically picked from optimal LinkedIn windows
7. **Post** — the scheduler publishes to LinkedIn via Playwright at the scheduled time

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

#### 5. Run persistently

Use [pm2](https://pm2.keymetrics.io/) to keep the scheduler running in the background and restart it on reboot:

```bash
npm install -g pm2
pm2 start npm --name "atomic-authority" -- run scheduler
pm2 save
pm2 startup
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
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token for HITL notifications and approval flow |
| `TELEGRAM_CHAT_ID` | Yes | Telegram chat ID to receive notifications |
| `LINKEDIN_HEADLESS` | No | Set to `true` for headless Playwright (default: `false`) |
