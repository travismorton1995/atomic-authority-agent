# Development Roadmap

## Phase 1: Immediate Optimizations

### 1a. Boost explainer post type weight
- Increase explainer from 15% → 20%
- Reduce another type by 5% to compensate
- Data-backed: explainers average 7x follower rate vs other types

### 1b. Variable post length by post type + track as metric
- hot-take / contrarian: target 120-150 words (shorter, punchier)
- bridge / explainer: target 180-220 words (more substance, dwell time)
- change-management / prediction / myth-busting: keep at 150-180 words
- Store word count on each post in posted_history.json
- Add word count to weekly report so we can correlate length with composite score

### 1c. Sharper contrarian / prediction / hot-take framing
- These types generate 0 followers across 3 posts. Adjust post type instructions to be more provocative, specific, and shareable.
- Predictions need bolder claims. Contrarian posts need a clearer "here's why the mainstream is wrong" edge. Hot takes need to feel like a real person's frustration, not commentary.

## Phase 2: Near-Term Features

### 2a. NPX Daily Prompter (original content pipeline)
- Telegram prompt each day (e.g. 5pm ET): "What are you working on? Any challenges or insights today?"
- User replies with free-text notes via Telegram
- Store daily notes in a local file (e.g. daily_notes.json)
- Weekly: assemble accumulated notes into an original post — "what I'm seeing from the inside" / "day in the life" / "lessons from building AI for nuclear"
- Feed through existing generation pipeline (screening, mentions, HITL approval) using the notes as source material instead of RSS
- This is the highest-value content differentiator — only Travis can write from inside NPX

### 2b. Analytics library integration
- Import a proper analytics/statistics library to handle performance analysis
- Replace hand-rolled averaging and ranking logic with robust statistical methods
- Enable more sophisticated analysis: correlation between post attributes and composite score, trend detection, confidence intervals on small sample sizes
- Powers better weekly reports and smarter feedback loops

### 2c. Post length performance tracking
- Add wordCount field to post metrics at publish time
- Include in composite score analysis via the analytics library
- Weekly report shows avg composite by word count bucket (short < 150 / medium 150-200 / long 200+)

## Phase 3: Future Exploration

### 3a. Carousel / PDF post generation
- New content format: 5-10 slide carousels for frameworks, explainers, or predictions
- Would need: PDF/image generation pipeline, new post type, LinkedIn document upload via Playwright
- Data suggests 3-6x organic boost over text-only posts
- Significant new development — separate feature branch

### 3b. Data-informed scheduling with exploration
- Replace hardcoded posting windows with a data-informed scheduler
- Balance exploitation (post at times/days with best historical composite scores) with exploration (occasionally try new windows to collect data)
- Could use a simple epsilon-greedy or UCB approach: 80% of the time pick the best-performing window, 20% of the time try a random window
- Use day-of-week and time-of-day performance from weekly reports as input
