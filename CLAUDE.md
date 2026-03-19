# Atomic Authority — Project Memory for Claude Code

## What This Is
A self-hosted, Human-in-the-Loop (HITL) LinkedIn content engine for the Nuclear/AI niche.
One post per day max, always requires human approval before posting.

## Stack
- Node.js v22+, TypeScript
- `@anthropic-ai/sdk` for all LLM calls (Claude)
- `node-cron` for scheduling
- `playwright` (raw, no stealth plugin needed — account has natural human activity)
- Discord webhook for HITL notifications

## Persona
**Voice:** 60% strategist / 40% practitioner
**Niche:** Professional AI developer working in the nuclear sector — specifically the intersection of AI and highly regulated industries
**Audiences (rotate):**
  - Nuclear professionals (regulatory, operations, engineering)
  - AI developers curious about the nuclear/regulated sector
  - Executives and decision-makers in energy

## Post Types (rotate through these)
- **The Bridge:** Connect a specific regulatory update (CNSC, NRC) to an AI capability. Concrete, data-anchored.
- **The Contrarian:** Challenge mainstream AI culture through the nuclear lens. "Move fast, simulate 10,000 times."
- **The Change Management:** AI implementation is 10% code, 90% org change. Human/trust angle.
- **The Explainer:** Break down a nuclear concept (ALARA, SMR, CANDU, Defense-in-Depth) for an AI audience, or vice versa.
- **The Hot Take:** Infrequent. Frustrated or pointed. Designed for engagement/clicks.

## Tone Rules
- Default: Engaging, optimistic, measured confidence
- Occasionally (~1 in 5 posts): Contrarian or frustrated — makes the feed more human and clickable
- ALWAYS: Avoid pure AI-isms ("transformative," "revolutionary," "dive in," "delve," "game-changer")
- ALWAYS: Include at least one industry-specific term per post (ALARA, SMR, CANDU, Defense-in-Depth, CNSC, IAEA, probabilistic risk assessment, etc.)
- Max post length: ~200 words for feed posts

## Posting Schedule Rules
- Max 1 post per day
- Best days: Tuesday, Wednesday, Thursday (prefer these)
- Best time windows (Eastern): 7:30–9:00am, 12:00–1:00pm, 5:00–6:30pm
- Add random variance (±15 min) to avoid robotic patterns
- Location: Stratford, ON (Eastern timezone)

## HITL Workflow
1. Agent generates draft → saves to `pending_posts.json`
2. Discord webhook fires with draft content
3. Human runs `npm run approve` or `npm run reject` to act on it
4. On approve: agent posts to LinkedIn and archives to `posted_history.json`

## Content Sources (RSS)
- World Nuclear News: https://www.world-nuclear-news.org/rss
- CNSC News: https://www.cnsc-ccsn.gc.ca/eng/resources/news/
- Canadian Nuclear Association: https://cna.ca/feed/

## File Structure
```
src/
  content/        # RSS fetcher, synthesis prompt, screening agent
  hitl/           # pending_posts.json manager, Discord notifier
  scheduler/      # cron logic, time window picker
  poster/         # LinkedIn browser automation
  cli/            # approve/reject/generate CLI commands
pending_posts.json
posted_history.json
user_data/          # LinkedIn session persistence (gitignored)
.env                # API keys (gitignored)
```

## Key Constraints
- Never post without human approval
- Never store credentials in code — use .env only
- All state is local files, no cloud DB
- `user_data/` and `.env` are always gitignored
