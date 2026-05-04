# Atomic Authority — Project Memory for Claude Code

## What This Is
A self-hosted, Human-in-the-Loop (HITL) LinkedIn content engine for the Nuclear/AI niche.
One post per day max. Content generation is automated; **publishing is manual** — the bot
prepares copy/paste-ready content and the user posts it on LinkedIn themselves.

## Stack
- Node.js v22+, TypeScript
- `@anthropic-ai/sdk` for all LLM calls (Claude)
- `node-cron` for scheduling
- `playwright` for any LinkedIn scraping (paused by default — see Pause State)
- Telegram bot for HITL notifications, approval flow, and copy/paste delivery
- Unsplash API for stock photo search (optional, free tier)

## Persona
**Voice:** 60% strategist / 40% practitioner
**Niche:** Professional AI developer working in the nuclear sector — specifically the intersection of AI and highly regulated industries
**Audiences (rotate):**
  - Nuclear professionals (regulatory, operations, engineering)
  - AI developers curious about the nuclear/regulated sector
  - Executives and decision-makers in energy

## Post Types (rotate through these, weighted random selection with balance multipliers)
- **The Bridge (30%):** Connect a specific regulatory update (CNSC, NRC) to an AI capability. Concrete, data-anchored. AI angle in first 2-3 sentences.
- **The Explainer (20%):** Break down a nuclear concept for an AI audience, or vice versa. Bullet-point friendly.
- **The Contrarian (10%):** Challenge mainstream AI culture through the nuclear lens.
- **The Change Management (15%):** AI implementation is 10% code, 90% org change. Human/trust angle.
- **The Myth-Busting (10%):** Identify and dismantle a misconception about nuclear or AI. "Myth vs. data" structure.
- **The Hot Take (5%):** Infrequent. Frustrated or pointed. Designed for engagement/clicks.
- **The Prediction (10%):** Specific, falsifiable, time-bounded claims about nuclear AI.
- **The Insider:** Weekly firsthand dispatch from NPX. Not in random rotation — triggered via daily notes/Friday check-in.

## Tone Rules
- Default: Engaging, optimistic, measured confidence
- Occasionally (~1 in 5 posts): Contrarian or frustrated — makes the feed more human and clickable
- ALWAYS: Avoid AI-isms ("transformative," "revolutionary," "dive in," "delve," "game-changer," "and it matters," etc.)
- ALWAYS: Include at least one industry-specific term per post
- ALWAYS: Include a "reference anchor" — a specific data point, named entity, list, or threshold worth bookmarking
- Acronyms: Common ones (AI, NRC, CNSC, IAEA, SMR, DOE, OPG) need no expansion. Uncommon ones must be expanded in brackets or replaced with plain language.

## Post Structure — Scannability Protocol
All posts follow a strict character-count-based 2:1 structure for mobile dwell time:
- **Hook:** < 140 characters, no emojis. Must include a number or named entity.
- **One-Liner:** 80–120 characters, single sentence
- **Mini-Paragraph:** 250–350 characters, 2–3 sentences
- **Pattern:** Hook → One-Liner → One-Liner → Mini-Para → One-Liner → One-Liner → Mini-Para → ...
- Never two Mini-Paragraphs back-to-back
- Word count: 80–240 (global hard limits, screener rewrites if outside)
- Bullet point exception: Explainer and Myth-Busting posts may use bulleted fact lists

## Hashtags
- 1 broad + 2 niche + 1 underused + 1 optional branded. Never exceed 5.
- Always CamelCase, single line at end of post.
- Selection: performance data first, curated fallback list second, relevance judgment third.

## First Comment Format
- **Sourced posts:** "Sourced from [Source Name].\n\n[Question?]" — no URL
- **Insider posts:** Question only — no source line, no URL
- Questions must be addressed to the audience (not the author), under 20 words

## Loopback Comment
A second comment posted ~24 hours after the original to expand the post's "Interest Graph"
on LinkedIn's algorithm.
- 25–60 words, full pipeline (verify + screen + length enforce)
- Must use 3+ technical keywords NOT in the original post
- Must use facts from the source article
- Question separated from rest by blank line
- One of three structures: Source-Fact Deep Dive, Implementation Friction Pivot, Future-Proofing Question

## Posting Schedule
- **Regular posts:** Tuesday/Wednesday/Thursday, target time **3:00–5:00 PM ET** (random minute within the window)
- **Insider posts:** Monday 3:00–5:00 PM ET
- **Generation cron:** Mon/Tue/Wed at **7:00 PM ET** — runs the V2 pipeline for the next day's post
- **One post per day max.**
- Location: Stratford, ON (Eastern timezone)

## V2 Pipeline (Interactive 8-Step Generation)
The generation cron triggers an interactive Telegram pipeline. Each step has buttons; user
walks through and approves at each stage:
1. **Article Selection** — top 5 ranked candidates with score breakdown, synopsis, suggested type
2. **Post-Type Selection** — recommended type + 2 alternatives with angle/perspective + balance status
3. **Hook Generation** — 5 hook options tailored to the chosen type, fact-checked
4. **Post Generation** — full post body using locked hook, type rules, and angle from step 2
5. **First Comment & Loopback** — generated separately, can be edited individually
6. **Mentions Confirmation** — verified mentions are bolded; user can run test-mentions
7. **Image Selection** — og:image + AI-generated + 3 stock photos + upload + none (existing flow)
8. **Schedule** — bot recommends a time within the next Tue/Wed/Thu 3-5pm ET window

After step 8, the bot **immediately** sends a copy/paste reminder with image, post text,
first comment, and loopback in `<pre>` code blocks. User pastes into LinkedIn's native
scheduler and sets the recommended time. Post is marked `published` with
`publishedAt = scheduledFor` (the future target time).

## Manual Posting Flow (Current)
**No Playwright is used to publish posts.** Instead:
1. V2 pipeline ends → bot sends Telegram message with image + post text + first comment + loopback in copy-pastable code blocks
2. Bot recommends a time: "📅 Schedule on LinkedIn for: Tue, May 5, 3:47 PM EDT"
3. User pastes into LinkedIn, uses LinkedIn's native scheduler
4. LinkedIn publishes at the scheduled time
5. Next morning at 9 AM ET, bot sends a loopback reminder (copy/paste, no scraping)
6. User checks LinkedIn manually — if no external comments, pastes the loopback as a reply

## Pause State
Triggered by a LinkedIn automation warning in May 2026. While paused (`/pause` command),
**all Playwright-based browser activity is disabled**:
- Comment poll on own posts
- Outbound reply monitor
- Outbound poll (finding new candidates)
- Pre-post engagement burst
- Midnight metrics snapshot
- `/poll`, `/outbound`, `/login`, `/flush_outbound` commands
- Approved comment-reply flushing (`flushApprovedReplies`)
- Approved outbound-comment flushing (`flushApprovedOutboundComments`)

While paused, the following still run:
- Post generation (V2 pipeline at 7 PM Mon/Tue/Wed and `/generate`)
- Daily notes prompts (Mon-Thu 4:45 PM, Fri weekly check-in)
- 8 AM session check (no scraping) and Monday weekly report (cached data)
- All Telegram-based content prep (no browser involved)
- Copy/paste publish reminder and loopback reminder

State persisted to `pause_state.json`. Optional auto-resume: `/pause 14` (14 days).
The dead Playwright code paths (postToLinkedIn, postFirstComment, postDueLoopbacks) are
retained intentionally so we can resume if LinkedIn cools off — they're gated by pause.

## Outbound Comment System (Paused by default)
When unpaused, the system finds posts to comment on:
- **Polls:** Weekdays 8 AM, 11 AM, 2 PM, 5 PM ET; Weekends 9 AM, 5 PM ET
- **Candidate scoring:** LLM relevance (65%) + recency (15%) + diversity (10%) + attribution bonus (10%)
- **Keyword pre-filter** gates candidates before LLM scoring
- **24-hour scrape window** for post discovery; 24-hour cooldown per profile
- **Comment rules:** 1–2 sentences, max 45 words, senior-professional level
- **Relationship modes:** insider, colleague, stranger
- **Pre-post burst:** 3-5 outbound comments queued 35 min before scheduled post (also paused)

## Insider Post Flow
1. **Mon–Thu 4:45 PM ET:** Daily notes prompt via Telegram
2. **Fri 4:45 PM ET:** Weekly insider check-in prompt (triggers generation when 2+ notes collected)
3. On approval: scheduled for Monday 3-5 PM ET
4. Strategic guardrails filter: Aggressive Incrementalism, Deterministic Guardrails, Cognitive Exoskeleton, Regulatory Testing Tax
5. No external links in post body. Hook grounded in weekly friction points.

## Telegram Commands
- `/generate` — Run V2 pipeline (interactive 8-step)
- `/generate <url>` — Generate from a specific article URL (single-shot legacy pipeline)
- `/insider` — Generate insider post from accumulated notes
- `/notes <text>` — Add a daily note
- `/outbound` — Run outbound engagement poll (paused by default)
- `/flush_outbound` — Post approved outbound comments (paused by default)
- `/poll` — Check for new comments on your posts (paused by default)
- `/metrics` — Send performance report (uses cached data, never blocked by pause)
- `/login` — Renew LinkedIn session (paused by default)
- `/schedule` — Show upcoming posts, bursts, loopbacks; pause status banner if paused
- `/pause [days]` — Pause all scraping/posting; optional auto-resume after N days
- `/resume` — Re-enable scheduled scraping
- `/types` — Show post type distribution vs targets
- `/help` — List all commands

## HITL Workflow (Current)
1. V2 pipeline generates draft through interactive Telegram steps
2. Each step has approve/edit/rewrite/reject buttons
3. After image selection (step 7), bot picks the recommended schedule time
4. Approval triggers: post saved as `published` with future `publishedAt`, copy/paste reminder sent
5. User pastes into LinkedIn manually using LinkedIn's native scheduler
6. Next morning 9 AM ET: loopback reminder sent (copy/paste, no scraping)

## Image Options (Step 7 of V2 pipeline)
- **Article image (og:image):** Extracted from source article. Validated with HEAD check.
- **AI-generated image:** FLUX model via Cloudflare Workers AI. Post-type-specific visual directions.
- **Stock photos (x3):** Unsplash API with 3 diverse angles. Filters clichés + previously-used. LLM picks best.
- **Upload your own:** Send a photo directly in Telegram.
- **No image:** Text-only post.

Bot delivers the chosen image as a Telegram photo for the user to download and attach to LinkedIn manually.

## Content Sources
- **11 RSS feeds:** CNSC, World Nuclear News, Canadian Nuclear Association, ANS Newswire, IAEA, Bruce Power, Power Magazine, Canadian Nuclear Society, Canadian Nuclear Laboratories, Utility Dive, Power Engineering
- **NewsData API:** Supplementary articles
- **Manual:** `/generate <url>` for specific articles (single-shot legacy pipeline)

## Comment Scraping (Text-Based, Paused by Default)
LinkedIn migrated to obfuscated CSS classes in May 2026, removing all `<article>` tags,
`data-id` and `data-urn` attributes from the comment DOM. All comment scrapers parse
`document.body.innerText` directly:
- Anchor on the comment composer (`[aria-label="Text editor for creating comment"]`) — only parse text after it (skips post body)
- Identify commenters by:
  - Standalone connection-degree marker (`· 1st` / `· 2nd` / `· 3rd+`)
  - Inline format (`Name • 2nd`)
  - Self-name match (own comments lack degree badge)
- Filter spurious self-name matches (quotes inside other comments)
- Dedupe nearby boundaries (LinkedIn renders names twice)
- Author cleanup strips `Premium Profile`, `Verified Profile`, `Influencer`, `Following`, `Author`, `You`, trailing degree
- Timestamp marker (incl. `(edited)` prefix) switches to content mode — skips subtitle/badge metadata
- Stop markers: `Like`, `Reply`, `X reactions`, `X impressions`, `See previous replies`, page footer

## File Structure
```
src/
  content/        # RSS fetcher, synthesis, screening, ranking, persona, image generation
                  # pipeline-v2.ts (interactive flow), synthesize-comments.ts (separate first/loopback)
  hitl/           # Telegram bot, daily notes, comment queue, outbound poll, pipeline-telegram.ts (V2)
  scheduler/      # cron jobs, time window picker, pause state, loopback reminder
  poster/         # LinkedIn browser automation (paused — kept for resume)
  outbound/       # Profile scraping, comment generation, monitor-replies, comment metrics
  cli/            # approve/reject/generate/post-now CLI commands
  analytics/      # Post data, performance reports, organic attribution, midnight snapshot,
                  # early-score, authority/discussion badges
mentions.json     # User-editable mention dictionary (replaces hardcoded TS dict)
pending_posts.json
posted_history.json
outbound_state.json
outbound_profiles.json
impression_snapshots.json
organic_attribution.json
hashtag_trends.json
hashtag_seen_posts.json
candidates_v2.json   # 1hr cache of ranked candidates (gitignored)
pipeline_sessions.json # V2 session persistence (gitignored)
pause_state.json     # Pause state (gitignored)
user_data/           # LinkedIn session persistence (gitignored)
.env                 # API keys (gitignored)
```

## Composite Score (360brew Formula)
```
score = (directFollowers + indirectFollowers) × 20
      + saves × 15
      + sends × 10
      + externalComments × 8        ← author comments excluded
      + reposts × 5
      + reactions × 1
```
Impressions tracked but not scored.

## Authority & Discussion Badges
- **Authority (A):** `saves / reactions ≥ 15%` — content is "reference-grade"
- **Discussion (D):** `externalComments / reactions ≥ 10%` — sparks engagement vs passive scroll
- Computed per post, shown in `/metrics` PDF reports

## Organic Follow Attribution
Attributes daily follower growth to posts and comments proportionally by same-day impressions.
**How it works:**
1. Midnight snapshot scrapes cumulative impressions for posts (90d) and comments (15d)
2. Delta between consecutive days = new impressions that day
3. Each day's follower delta is distributed proportionally by delta impressions
4. Posts with direct follows (LinkedIn-attributed) get discounted weight
5. Indirect pool = follower delta minus direct follows, distributed by discounted weights
6. Once a day is computed, it's permanent — never revisited

**Data files:**
- `impression_snapshots.json` — daily cumulative impressions per item (compact `[date, impressions, newFollowers?]` tuples, 2 days retained)
- `organic_attribution.json` — daily attribution breakdowns + post/profile rollups (90 days retained)

## Midnight Snapshot (Paused by Default)
Single cron at midnight ET. When unpaused, one browser session handles all scraping:
1. Follower count → `follower_history.json`
2. Post metrics (90d) → `posted_history.json`
3. Comment metrics (15d) → `outbound_state.json` (uses text-based parser)
4. Record impression snapshots → `impression_snapshots.json`
5. Compute organic attribution → `organic_attribution.json`

Retries up to 3 times with exponential backoff. Telegram alert if all retries fail.

8 AM maintenance does NOT scrape — only session check, cleanup, Monday report PDF.

## Key Constraints
- **Never automate posting.** All posts go to LinkedIn manually via copy/paste.
- Never store credentials in code — use .env only
- All state is local files, no cloud DB
- `user_data/`, `.env`, `pause_state.json`, `candidates_v2.json`, `pipeline_sessions.json` are always gitignored
- Browser lock ensures only one Playwright context at a time (all acquisitions have generous timeouts)
- LinkedIn flagged the account for automation in May 2026 — pause is the default safe state
