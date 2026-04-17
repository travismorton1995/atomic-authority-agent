# Atomic Authority — Project Memory for Claude Code

## What This Is
A self-hosted, Human-in-the-Loop (HITL) LinkedIn content engine for the Nuclear/AI niche.
One post per day max, always requires human approval before posting.

## Stack
- Node.js v22+, TypeScript
- `@anthropic-ai/sdk` for all LLM calls (Claude)
- `node-cron` for scheduling
- `playwright` (raw, no stealth plugin needed — account has natural human activity)
- Telegram bot for HITL notifications and approvals
- Unsplash API for stock photo search (optional, free tier)

## Persona
**Voice:** 60% strategist / 40% practitioner
**Niche:** Professional AI developer working in the nuclear sector — specifically the intersection of AI and highly regulated industries
**Audiences (rotate):**
  - Nuclear professionals (regulatory, operations, engineering)
  - AI developers curious about the nuclear/regulated sector
  - Executives and decision-makers in energy

## Post Types (rotate through these, weighted random selection with balance multipliers)
- **The Bridge (30%):** Connect a specific regulatory update (CNSC, NRC) to an AI capability. Concrete, data-anchored.
- **The Explainer (20%):** Break down a nuclear concept for an AI audience, or vice versa.
- **The Contrarian (15%):** Challenge mainstream AI culture through the nuclear lens.
- **The Change Management (15%):** AI implementation is 10% code, 90% org change. Human/trust angle.
- **The Myth-Busting (10%):** Identify and dismantle a misconception about nuclear or AI.
- **The Hot Take (8%):** Infrequent. Frustrated or pointed. Designed for engagement/clicks.
- **The Prediction (7%):** Specific, falsifiable, time-bounded claims about nuclear AI.
- **The Insider:** Weekly firsthand dispatch from NPX. Not in random rotation — triggered via daily notes/Friday check-in.

## Tone Rules
- Default: Engaging, optimistic, measured confidence
- Occasionally (~1 in 5 posts): Contrarian or frustrated — makes the feed more human and clickable
- ALWAYS: Avoid AI-isms ("transformative," "revolutionary," "dive in," "delve," "game-changer," "and it matters," etc.)
- ALWAYS: Include at least one industry-specific term per post
- Acronyms: Common ones (AI, NRC, CNSC, IAEA, SMR, DOE, OPG) need no expansion. Uncommon ones must be expanded in brackets or replaced with plain language.

## Post Structure — Scannability Protocol
All posts follow a strict character-count-based 2:1 structure for mobile dwell time:
- **Hook:** < 140 characters, no emojis
- **One-Liner:** 80–120 characters, single sentence
- **Mini-Paragraph:** 250–350 characters, 2–3 sentences
- **Pattern:** Hook → One-Liner → One-Liner → Mini-Para → One-Liner → One-Liner → Mini-Para → ...
- Never two Mini-Paragraphs back-to-back

## First Comment Format
- **Sourced posts:** "Sourced from [Source Name].\n\n[Question?]" — no URL
- **Insider posts:** Question only — no source line, no URL
- Questions must be addressed to the audience (not the author), under 20 words

## Posting Schedule Rules
- Max 1 post per day
- **Regular posts:** Tuesday, Wednesday, Thursday — 5 experimental time windows (7:30am, 10:30am, 12pm, 3pm, 5pm ET), least-used bucket selected
- **Insider posts:** Sunday 7:00–8:00pm ET
- Location: Stratford, ON (Eastern timezone)

## Insider Post Flow
1. **Mon–Thu 4:45pm ET:** Daily notes prompt via Telegram
2. **Fri 4:45pm ET:** Weekly insider check-in prompt (triggers generation when 2+ notes collected)
3. On approval: scheduled for Sunday 7–8pm ET
4. Strategic guardrails filter: Aggressive Incrementalism, Deterministic Guardrails, Cognitive Exoskeleton, Regulatory Testing Tax
5. No external links in post body. Hook grounded in weekly friction points.

## Outbound Comment System
- **Polls:** Weekdays 8am, 11am, 2pm, 5pm ET; Weekends 9am, 5pm ET
- **Candidate scoring:** LLM relevance (65%) + recency (15%) + diversity (10%) + attribution bonus (10%)
- **Keyword pre-filter** gates candidates before LLM scoring (zero-hit = skip)
- **24-hour scrape window** for post discovery
- **24-hour cooldown** per profile to prevent spam
- **Repost detection** on both poll and ad-hoc paths
- **Comment rules:** 1–2 sentences, max 45 words, senior-professional level (not domain-expert)
- **Relationship modes:** insider, colleague, stranger (affects approach selection)
- **Ad-hoc:** Paste a LinkedIn post URL in Telegram to generate comment options

## Telegram Commands
- `/generate` — Run content pipeline (normal RSS ranking)
- `/generate <url>` — Generate post from a specific article URL
- `/insider` — Generate insider post from accumulated notes (min 1 note)
- `/notes <text>` — Add a daily note
- `/outbound` — Run outbound engagement poll manually
- `/poll` — Check for new comments on published posts
- `/metrics` — Send performance report (no scraping — uses midnight data)
- `/login` — Renew LinkedIn session

## HITL Workflow
1. Agent generates draft → saves to `pending_posts.json`
2. Telegram notification with draft, cringe score, and image options
3. Human approves (with image choice) or rejects via Telegram buttons
4. On approve: scheduled for next available time window (or Sunday for insider)
5. Scheduler publishes when scheduled time arrives, archives to `posted_history.json`

## Image Options
On approval, up to 5 image sources are offered via Telegram:
- **Article image (og:image):** Extracted from source article. Validated with HEAD check before showing.
- **AI-generated image:** FLUX model via Cloudflare Workers AI. Post-type-specific visual directions.
- **Stock photos (x3):** Unsplash API search with 3 diverse angles per post (setting / people / metaphor). Each angle searches independently, filters clichés and previously-used images, then LLM picks the best from each search's top 5. Requires `UNSPLASH_ACCESS_KEY` env var.
- **Upload your own:** Send a photo directly in Telegram.
- **No image:** Text-only post.
Analytics track engagement by image type (og, ai, custom, stock, none).

## Content Sources
- **11 RSS feeds:** CNSC, World Nuclear News, Canadian Nuclear Association, ANS Newswire, IAEA, Bruce Power, Power Magazine, Canadian Nuclear Society, Canadian Nuclear Laboratories, Utility Dive, Power Engineering
- **NewsData API:** Supplementary articles
- **Manual:** `/generate <url>` for specific articles

## File Structure
```
src/
  content/        # RSS fetcher, synthesis, screening, ranking, persona, image generation
  hitl/           # Telegram bot, daily notes, comment queue, outbound poll
  scheduler/      # cron jobs, time window picker
  poster/         # LinkedIn browser automation, browser lock, comments, mentions
  outbound/       # Profile scraping, comment generation, relevance scoring, comment metrics
  cli/            # approve/reject/generate/post-now CLI commands
  analytics/      # Post data tracking, performance reports, organic attribution, midnight snapshot
pending_posts.json
posted_history.json
outbound_state.json
outbound_profiles.json
impression_snapshots.json
organic_attribution.json
candidates.json
daily_notes.json
user_data/          # LinkedIn session persistence (gitignored)
.env                # API keys (gitignored)
```

## Organic Follow Attribution
Attributes daily follower growth to posts and comments proportionally by same-day impressions.

**How it works:**
1. Midnight snapshot scrapes cumulative impressions for posts (90d) and comments (15d)
2. Delta between consecutive days = new impressions that day
3. Each day's follower delta is distributed proportionally by delta impressions
4. Posts with direct follows (LinkedIn-attributed) get discounted weight: `discountedWeight = deltaImpressions - (directFollows × impressions/follow ratio)`
5. Indirect pool = follower delta minus direct follows, distributed by discounted weights
6. Once a day is computed, it's permanent — never revisited

**Data files:**
- `impression_snapshots.json` — daily cumulative impressions per item (compact `[date, impressions, newFollowers?]` tuples, 2 days retained)
- `organic_attribution.json` — daily attribution breakdowns + post/profile rollups (90 days retained)

**Feedback loop:** Profile attribution bonus feeds into outbound profile selection. Profiles whose comments generate more indirect follows per comment get higher priority (`getOrganicProfileBonus()`). Blended with the older lift-based bonus via `max()`.

## Midnight Snapshot
Single cron at midnight ET. One browser session handles all scraping:
1. Follower count → `follower_history.json`
2. Post metrics (90d) → `posted_history.json`
3. Comment metrics (15d) → `outbound_state.json`
4. Record impression snapshots → `impression_snapshots.json`
5. Compute organic attribution → `organic_attribution.json`

Retries up to 3 times with exponential backoff (1m, 2m, 4m). Telegram alert if all retries fail. Follower count + post metrics are critical (trigger retry); comment metrics + attribution are non-critical.

8am maintenance does NOT scrape — only session check, cleanup, and Monday report PDF. `/metrics` command sends report from local data only.

## Key Constraints
- Never post without human approval
- Never store credentials in code — use .env only
- All state is local files, no cloud DB
- `user_data/` and `.env` are always gitignored
- Browser lock ensures only one Playwright context at a time (all acquisitions have timeouts)
