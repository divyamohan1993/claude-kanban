# AI Survival Guide: A Living Platform for the Post-AI World

## North Star

The world changed. AI is not coming; it arrived. Millions of people, from students who never touched a computer to senior engineers with decades of experience, are asking the same question: "What do I do now?"

Nobody has a concrete answer. The internet is flooded with speculation, hype, fear, and noise. Every "AI skills" article is outdated before it's published. Every course teaches yesterday's tools. Every prediction is wrong within months.

This platform is the antidote. A single, self-sufficient, always-current guide that researches the real landscape every day, verifies claims against real data, and tells people exactly what skills matter right now, what to learn next, and how to learn it, from absolute zero to mastery. Not opinions. Not speculation. Facts. Data. Evidence. Updated continuously by AI, for humans.

One file. One folder. One orchestrator. Forever.

## The Problem (Why This Exists)

1. **Information asymmetry**: People who need guidance most have the least access to good information. A farmer's child in rural India and a CS grad in Bangalore face the same AI disruption but have wildly different starting points.
2. **Noise-to-signal ratio is catastrophic**: For every useful AI career insight, there are 100 speculative LinkedIn posts, clickbait articles, and outdated courses. People cannot distinguish real from fake.
3. **Static guides are useless**: Any "AI skills roadmap" written today is partially obsolete tomorrow. A new model drops, a new tool launches, an entire job category shifts. Static content cannot serve a dynamic world.
4. **No single source of truth**: Job boards say one thing, researchers say another, influencers say a third. There is no platform that cross-references all sources and presents verified, weighted conclusions.
5. **Accessibility gap**: Most AI education assumes literacy, internet fluency, English proficiency, and a computer. Billions of people have none of these.

## Who Uses This

- **Tier 0 - Digital Zero**: Never used a computer. Possibly illiterate. Needs audio/visual guidance in local languages. Learns what technology is, why it matters, how to start.
- **Tier 1 - Digital Beginner**: Can use a phone, basic apps. Needs to understand what AI is, how it affects their work (farming, retail, trades), what basic digital skills to build.
- **Tier 2 - Student/Early Career**: In school or just starting work. Needs to know which subjects matter now, which careers are growing vs shrinking, what tools to learn.
- **Tier 3 - Working Professional**: Has a job. Needs to know how AI changes their role, what to upskill in, how to stay relevant, what tools to adopt today.
- **Tier 4 - Technical Professional**: Developer, engineer, data scientist. Needs cutting-edge skill tracking: which frameworks, models, techniques are production-ready now vs hype.
- **Tier 5 - Leader/Entrepreneur**: Needs strategic intelligence: market shifts, investment patterns, regulatory changes, workforce planning signals.

## Core Features

### 1. The Research Engine (Heart of the Platform)

This is not a static website. It is a living research system.

**How it works:**
- On every orchestrator cycle, the platform researches the current AI landscape
- Sources: job postings (real aggregated data from major platforms), research papers (arXiv, Semantic Scholar), industry reports (McKinsey, WEF, Gartner, NASSCOM), government policy updates, open-source project activity (GitHub trending, npm downloads, PyPI stats), Stack Overflow trends, Reddit/HN discussions (sentiment-weighted), official AI lab announcements
- Every claim gets a source URL, retrieval date, and confidence score
- Contradictory sources are flagged and presented as "contested" rather than picking a side
- Stale data (older than configurable threshold, default 7 days for fast-moving topics, 30 days for structural trends) gets auto-flagged for re-research
- Research results stored in SQLite with full provenance chain

**Research categories:**
- Skills in demand (by region, by industry, by experience level)
- Tools and platforms gaining/losing traction (with real adoption metrics, not hype)
- Job market signals (new role types appearing, old ones declining, salary trends)
- AI capability frontier (what AI can/cannot do today, verified by benchmarks not marketing)
- Policy and regulation updates (EU AI Act, India DPDPA, US executive orders)
- Education and certification value (which credentials actually correlate with employment)

### 2. The Skill Map (Dynamic, Not Static)

A living dependency graph of skills, updated by the research engine.

**Structure:**
- Each skill node has: name, description, tier (0-5), prerequisites, estimated learning time, current demand score (from research), trend direction (rising/falling/stable), recommended resources (free first, paid only if significantly better), practice exercises
- Skills grouped into clusters: foundational digital literacy, communication with AI, data literacy, domain-specific AI application, AI tool proficiency, technical AI/ML, AI strategy and ethics
- The graph updates automatically as research reveals new skills becoming important or old ones becoming irrelevant
- "Skill decay" tracking: warns when a skill the user is learning is declining in relevance

**Key skill areas (initial, will evolve):**
- Prompt engineering and AI collaboration (the new literacy)
- Critical evaluation of AI outputs (the new critical thinking)
- Data interpretation without coding (the new numeracy)
- AI-augmented workflows for every profession (not just tech)
- Ethical AI usage and bias recognition
- Automation design thinking (identifying what to automate)
- Human skills AI cannot replace: empathy, physical craft, creative judgment, ethical reasoning, cultural context, relationship building

### 3. The Learning Pathways (Adaptive, Personalized)

Not courses. Pathways. Each person gets a different route based on where they are and where they need to go.

**How pathways work:**
- User self-selects their tier (0-5) and their domain (education, healthcare, agriculture, retail, tech, government, creative, trades, etc.)
- Platform generates a personalized skill sequence from the skill map
- Each step has: what to learn, why it matters now (backed by research data), how to learn it (free resources prioritized), how to verify you learned it (practical exercises, not quizzes)
- Pathways dynamically reorder as the research engine detects shifts
- "Express lanes": when a new tool/skill becomes critical (e.g., a breakthrough model), it gets fast-tracked into relevant pathways with urgency indicators

**Accessibility requirements:**
- Tier 0-1: Audio narration, visual diagrams, minimal text, available in Hindi, English, and expandable to other languages
- All tiers: Screen reader compatible, keyboard navigable, works on slow connections (< 1 Mbps), works on old devices (target: 5-year-old Android phone browser)
- Content degrades gracefully: no JS required for core content reading, JS enhances interactivity
- High contrast mode, adjustable font sizes, dyslexia-friendly font option

### 4. The Reality Dashboard

A single-page view showing the current state of the AI world, backed entirely by data.

**Sections:**
- **Today's AI Landscape**: What changed in the last 24-48 hours (new model releases, major announcements, policy changes)
- **Skills Heat Map**: Visual representation of which skills are hot/cold right now, filterable by region and industry
- **Job Market Pulse**: Real signals from aggregated job data, not surveys. New roles appearing, compensation trends, remote vs on-site shifts
- **AI Capability Tracker**: What AI can do today (with benchmark citations), what it cannot, what changed recently
- **Myth Buster**: Top 5 current AI misconceptions, debunked with sources. Rotates based on what's trending in public discourse
- **Weekly Digest**: Auto-generated summary of the week's most important changes, written for each tier level

### 5. The Honesty Engine

The platform's unique differentiator: radical transparency about what it knows and does not know.

- Every data point shows: source, retrieval date, confidence level (high/medium/low/contested)
- Predictions are explicitly labeled as predictions with stated assumptions
- "We don't know" is a valid and frequently used answer
- Contradictory expert opinions are presented side-by-side, not resolved into false consensus
- The platform explicitly states its own limitations and biases
- Version history: users can see how the platform's recommendations changed over time and why

## Tech Stack

- **Runtime**: Node.js (LTS) + Express
- **Database**: SQLite (WAL mode) for content, research cache, user preferences, skill graphs
- **Frontend**: Vanilla HTML/CSS/JS. No framework. No build step. Works everywhere.
- **Styling**: CSS custom properties for theming. Dark/light/high-contrast modes. Responsive from 320px to 4K.
- **Real-time**: SSE for live content updates when research completes
- **Process Manager**: PM2 for auto-restart, crash recovery, log management
- **Reverse Proxy**: Nginx on port 80, proxying to app on internal port
- **Research**: The orchestrator brainstorms research tasks as cards. Each build cycle, Claude reads current web data (via tool use) and writes structured findings to the DB. This means research quality is bounded by what Claude can access and verify in a single session. The URL verification layer (Risk 2) catches hallucinated sources.
- **Content Format**: Structured JSON in SQLite, rendered to semantic HTML server-side. No client-side rendering of research data.
- **Audio**: Browser-native Speech Synthesis API (zero-cost, works offline, no API dependency). Quality varies by device; this is acceptable for v1. Upgraded TTS is a Phase 4+ concern.
- **i18n**: Content stored with language keys. English first (Phase 1-3), Hindi added in Phase 4. The i18n framework is built into the DB schema from day one so it doesn't require a rewrite later, but translated content waits until the English content is proven useful.

## Architecture

### Self-Sufficiency Contract

This platform, once deployed, requires zero human intervention. The orchestrator handles everything:

1. **Content stays current**: The research engine runs on every orchestrator discovery cycle. New findings become brainstorm cards, get built, reviewed, and merged automatically.
2. **Bugs get fixed**: The platform exposes `/health` (shallow) and `/health/ready` (deep, checks DB + research freshness). If health degrades, the orchestrator's self-healing creates a fix card.
3. **Auto-deploy**: `autoconfig.sh` takes a blank Ubuntu server to running platform on port 80. Idempotent. Run it once, never think about it again.
4. **Auto-restart**: PM2 watches the process. Crash? Restart in <2 seconds. Memory leak? Auto-restart at threshold.
5. **Auto-update**: When the orchestrator commits new code, a git hook or cron job pulls and restarts. Zero-downtime reload via PM2.
6. **Log rotation**: PM2 log rotation + orchestrator housekeeping prevents disk fill.
7. **Backup**: SQLite WAL checkpoint + file copy on housekeeping cycle.

### Directory Structure

```
/
  idea.md              ← this file (north star, never deleted)
  package.json         ← dependencies
  src/
    server.js          ← Express app, routes, SSE, health checks
    db/
      index.js         ← SQLite schema: content, skills, research_cache, pathways, users_prefs
      migrations/      ← schema evolution scripts
    research/
      engine.js        ← core research orchestration
      sources/         ← per-source adapters (jobs, papers, trends, policy)
      scorer.js        ← confidence scoring + contradiction detection
      freshness.js     ← staleness detection + re-research triggers
    content/
      renderer.js      ← JSON content → semantic HTML
      skill-graph.js   ← skill dependency graph engine
      pathways.js      ← pathway generation + dynamic reordering
      dashboard.js     ← reality dashboard aggregation
      honesty.js       ← source attribution + confidence display
      digest.js        ← weekly digest auto-generation
    i18n/
      index.js         ← language detection + content routing
      en.json          ← English strings
      hi.json          ← Hindi strings
    accessibility/
      audio.js         ← TTS integration for Tier 0-1
      contrast.js      ← high contrast + dyslexia mode
  public/
    index.html         ← landing page: tier selector + dashboard
    pathway.html       ← personalized learning pathway view
    skill-map.html     ← interactive skill dependency graph
    dashboard.html     ← reality dashboard
    digest.html        ← weekly digest archive
    css/
      main.css         ← core styles, custom properties, responsive
      accessibility.css ← high contrast, large text, dyslexia modes
    js/
      app.js           ← routing, SSE connection, tier management
      skill-graph.js   ← client-side skill map visualization (canvas/SVG)
      dashboard.js     ← live dashboard updates
    audio/             ← cached TTS audio files
  seed/
    skills-baseline.json   ← hand-verified starting skills (30-50, with real URLs)
    dashboard-day-zero.json ← AI landscape snapshot as of build date
    pathways-starter.json  ← 3-4 starter pathways for Tiers 2-4
  autoconfig.sh        ← blank server → running platform on port 80
  .env.example         ← all configuration with safe defaults
  CHANGELOG.md         ← auto-maintained by orchestrator
```

### Database Schema (Core Tables)

```sql
-- Research findings with full provenance
research_cache (
  id, topic, category, source_url, source_name,
  retrieved_at, content_json, confidence_score,
  contradicted_by, language, expires_at,
  created_at, updated_at
)

-- Skill nodes in the dependency graph
skills (
  id, name, slug, description, tier,
  cluster, prerequisites_json, demand_score,
  trend_direction, trend_updated_at,
  learning_hours, resources_json, exercises_json,
  language, created_at, updated_at
)

-- Skill relationships (graph edges)
skill_edges (
  id, from_skill_id, to_skill_id, relationship_type,
  strength, created_at
)

-- Learning pathways (templates + user-specific)
pathways (
  id, tier, domain, skill_sequence_json,
  generated_at, research_version,
  created_at, updated_at
)

-- Dashboard snapshots
dashboard_snapshots (
  id, snapshot_date, landscape_json,
  heat_map_json, job_pulse_json,
  capability_json, myths_json,
  created_at
)

-- Weekly digests
digests (
  id, week_start, week_end, tier,
  content_json, sources_json, language,
  created_at
)

-- Content blocks (rendered sections)
content_blocks (
  id, page, section, tier, language,
  content_html, content_audio_url,
  research_ids_json, freshness_score,
  created_at, updated_at
)

-- User preferences (anonymous, cookie-based)
user_prefs (
  id, session_id, tier, domain, language,
  accessibility_prefs_json, pathway_progress_json,
  created_at, updated_at
)

-- Research source health (Risk 8 mitigation)
research_source_health (
  id, source_name, adapter_name,
  last_success_at, last_failure_at,
  consecutive_failures, total_fetches,
  avg_quality_score, status,
  created_at, updated_at
)

-- Corrections log (Risk 9 mitigation: public, append-only)
corrections (
  id, original_recommendation, original_date,
  correction, correction_date, reason,
  category, affected_skill_ids_json,
  created_at
)

-- Research verification (Risk 2 mitigation: hallucination defense)
research_verifications (
  id, research_id, verification_type,
  url_reachable, content_matches_claim,
  adversarial_challenge_result,
  verified_at, verifier_session_id,
  created_at
)
```

### API Endpoints

```
GET  /                          → Landing page (tier selector + today's snapshot)
GET  /pathway/:tier/:domain     → Personalized learning pathway
GET  /skills                    → Full skill map (filterable)
GET  /skills/:slug              → Single skill detail + research backing
GET  /dashboard                 → Reality dashboard (live data)
GET  /digest                    → Latest weekly digest
GET  /digest/:week              → Historical digest
GET  /api/research/latest       → Raw latest research findings (JSON)
GET  /api/skills/heat-map       → Skills demand heat map data
GET  /api/dashboard/snapshot    → Current dashboard data (JSON)
GET  /api/stream                → SSE: live updates when research/content changes

GET  /corrections               → Public corrections log (retracted/changed recommendations)

GET  /health                    → Shallow health (process alive, port responding)
GET  /health/ready              → Deep health (DB connected, research fresh, content rendered, sources healthy)
```

### Performance Budget

- **First paint**: < 1.5s on 3G connection
- **Full interactive**: < 3s on 3G
- **Total page weight**: < 150KB gzip (no frameworks, no bloat)
- **API response**: < 100ms p95 for cached content, < 2s for live research queries
- **Works offline**: Service worker caches last-known content. "Last updated: X" shown prominently.
- **No JavaScript required**: Core content readable as server-rendered HTML. JS enhances (live updates, interactivity, visualizations) but is not required.

## Content Principles

1. **Concrete over abstract.** "Learn prompt engineering" is useless. "Practice writing prompts that extract structured data from unstructured text, because 73% of data analyst job postings now list this skill (source: aggregated job data, March 2026)" is useful.

2. **Verified over viral.** If something is trending on social media but has no supporting data, it gets flagged as "unverified hype" not presented as fact.

3. **Actionable over informational.** Every section ends with "Do this next" -- a specific, free, immediately actionable step. Not "consider learning Python" but "Open this free browser-based Python exercise and complete lesson 1 (15 minutes)."

4. **Honest over reassuring.** If a job category is declining, say so with data. If AI cannot do something, say so with evidence. No false hope, no false doom.

5. **Inclusive over sophisticated.** A farmer in UP and a developer in Bangalore should both find value on the same platform. Content adapts to tier, never talks down to anyone.

6. **Fresh over comprehensive.** A smaller set of verified, current insights beats a larger set of possibly-outdated information. Staleness is worse than gaps.

## Auto-Deploy Specification

### autoconfig.sh Requirements

The script takes a blank Ubuntu 22.04+ server to a fully running platform on port 80:

```
1. System: apt update, install Node.js LTS, Nginx, PM2 (global), certbot
2. App: clone repo (or pull if exists), pnpm install --frozen-lockfile
3. Env: generate .env from .env.example if missing, random secrets on first run
4. DB: auto-migrate on app start (no manual step)
5. Nginx: reverse proxy port 80 → app port (from .env), gzip, security headers
6. PM2: start app with --watch for auto-restart on file changes
7. Cron: git pull + pnpm install + pm2 reload every 5 minutes (picks up orchestrator commits)
8. UFW: allow 80, 443, 22 only
9. Certbot: auto-SSL if domain configured in .env
10. Health: verify GET /health returns 200
11. Log rotation: PM2 log rotate, max 10MB per file, 5 files retained
```

Idempotent: safe to run repeatedly. Secrets preserved on rerun. Everything logged to `/var/log/autoconfig.log`.

### Auto-Update Flow

```
Orchestrator commits code to GitHub
  ↓ (every 5 min cron on server)
git pull --ff-only
  ↓ (if changes detected)
pnpm install --frozen-lockfile
  ↓
pm2 reload app --update-env
  ↓
GET /health (verify)
  ↓ (if health fails)
pm2 restart app
  ↓ (if still fails)
Orchestrator detects via /health/ready, creates fix card
```

### Error Reporting Back to Orchestrator

The platform writes structured error logs that the orchestrator's self-healing scanner can parse:

- All unhandled exceptions → logged with stack trace, request context, timestamp
- Research failures (source unreachable, API errors) → logged with source name, error type, retry count
- Content staleness alerts → logged when any content block exceeds freshness threshold
- Health check failures → logged with specific failing component (DB, research, render)

Format matches the orchestrator's `error_log` expectations: `{ level, message, card_id (if applicable), stack, timestamp }`.

## Strategic Improvement Areas (For Auto-Discovery)

These are the areas where the orchestrator should continuously seek improvements:

1. **Research source expansion**: Find and integrate new reliable data sources for AI landscape tracking
2. **Content accessibility**: Improve audio quality, add more languages, better low-bandwidth experience
3. **Skill graph accuracy**: Cross-validate skill demand scores against multiple independent sources
4. **Pathway effectiveness**: Track which learning paths users actually complete vs abandon, optimize accordingly
5. **Dashboard freshness**: Reduce time between real-world event and dashboard reflection
6. **Mobile experience**: Ensure every interaction works on a 5-year-old phone with a cracked screen on 2G
7. **Myth detection**: Improve the system's ability to identify and debunk trending misinformation
8. **Regional relevance**: Make skill recommendations region-aware (India vs US vs EU markets differ)
9. **Offline capability**: Expand service worker coverage so the platform is useful without internet
10. **Trust signals**: Add more provenance metadata, visualize source reliability history

## What Success Looks Like

- A person with zero digital literacy opens this on a shared village phone and hears, in Hindi, what skills will help them earn more in the next 6 months. The advice is specific, actionable, and backed by real employment data from their region.
- A CS student opens this and sees, backed by real GitHub/npm/job data, that the framework they're learning is declining and what to switch to. The recommendation changed last Tuesday because a major industry shift happened.
- A 45-year-old accountant opens this and finds a clear, honest, non-condescending pathway from "AI is scary" to "I use AI to do my job twice as fast." Each step takes 15-30 minutes and links to free resources.
- A CTO opens the dashboard and gets a single-page view of what AI capabilities are production-ready this week, what's still research-only, and what regulatory changes are coming. Every claim has a source link. Contested claims are labeled as contested.
- The platform has been running for 6 months. Nobody has logged into the server. The content is current as of yesterday. Three bugs were auto-fixed by the orchestrator. Two new data sources were auto-integrated. The skill map has evolved significantly from its initial state because the world changed and the platform changed with it.

## Known Risks and Mitigations

Every decision below was challenged. These are the real failure modes and how we prevent them.

### Risk 1: "Everything for everyone" serves no one

**Devil's advocate**: A farmer's child needs a phone app with audio in Hindi. A CTO needs a data dashboard in English. Forcing them into one platform serves neither. This is Google Wave -- ambitious, unfocused, dead.

**Mitigation**: Tier-gated rendering. The platform is NOT one product with one UI. It is one data engine with multiple presentations:
- Tier 0-1: A completely separate, minimal HTML page. Large icons, audio-first, local language. No skill graphs, no dashboards, no jargon. Think of it as a different app that shares the same database. Built LAST (Phase 4), not first.
- Tier 2-3: The core experience. Clean, readable, action-oriented. This is the primary audience and gets built FIRST.
- Tier 4-5: Data-dense dashboard view. Tables, trend charts, source links. Built in Phase 3.

If Tier 0-1 never ships, the platform is still valuable for Tiers 2-5. If Tier 4-5 is sparse, Tiers 2-3 still work. Each tier is independently useful. No tier blocks another.

### Risk 2: AI researching AI is meta-circular (hallucination risk)

**Devil's advocate**: The research engine uses Claude to find and summarize information. Claude hallucinates. A hallucinated source URL with a fake confidence score is WORSE than no data, because it wears the mask of credibility. The "honesty engine" trusts its own research, which is the exact problem.

**Mitigation -- three layers of defense**:

1. **URL verification**: Every source URL the research engine produces MUST be fetched and verified to return a 200 status with relevant content. If the URL is dead or content doesn't match the claim, the finding is marked `unverified` and shown with a warning, never as fact. This is a hard gate, not optional.

2. **Cross-source requirement**: No single-source claims get `high` confidence. Ever. A finding needs 2+ independent sources to reach `high`. Single-source findings are `low` confidence and labeled "single source, treat with caution." This is enforced in the scorer, not the prompt.

3. **Hallucination canary**: 10% of research findings are randomly selected for re-verification in a separate Claude session that is explicitly prompted to be adversarial: "Try to disprove this claim. Find contradicting evidence." If the adversarial session finds problems, the finding is downgraded or removed.

4. **Human-verifiable trail**: Every displayed claim links directly to its source. Users can click and verify themselves. The platform never asks users to "trust us." It says "here's what we found, here's where we found it, here's how confident we are, click to verify."

**Worst case if this fails**: The platform publishes a hallucinated finding that looks credible. The freshness system catches it within 7 days (the re-research cycle). Damage is limited because the platform always shows confidence levels, and users who click source links will find the broken link. The "corrections log" (see below) publicly records every retraction.

### Risk 3: Cold start -- Day one is empty

**Devil's advocate**: User visits on day one. Database is empty. No research has run. They see a spinner, or worse, an empty dashboard with "No data available." First impression is "this is broken." They leave and never return.

**Mitigation -- Seed content**:

The build process includes a `seed/` directory with curated, hand-verified starting content:
- `seed/skills-baseline.json`: 30-50 foundational skills with verified demand data, sources, and dates. This is NOT generated, it is researched during the build phase with real URLs.
- `seed/dashboard-day-zero.json`: A snapshot of the AI landscape as of build date. Clearly labeled "Seed data from [date]. Live research will update this within 24 hours."
- `seed/pathways-starter.json`: 3-4 basic pathways (Tier 2 student, Tier 3 professional, Tier 4 developer) with known-good resource links.

On first boot, if the DB is empty, the seed data is loaded. Every seed item has `is_seed: true` flag. As real research replaces seed data, the seed flag is cleared and the provenance chain starts. The UI shows "Based on seed data from [date]" until replaced by live research.

The platform is useful from minute one. Imperfect, but useful.

### Risk 4: Internal contradictions

**Devil's advocate**: The spec says "No JavaScript required" AND "Interactive skill graph visualization." It says "Works on 2G" AND "Real-time SSE updates." These are contradictory. Pick one or acknowledge the tradeoff.

**Resolution**:

- **No-JS baseline**: All CONTENT is server-rendered HTML. A user with JS disabled sees every skill, every pathway, every dashboard number as plain text and tables. This is the accessibility floor.
- **JS enhances**: The skill graph visualization, live SSE updates, and interactive filters are progressive enhancements. They make the experience better but are not required. The `<noscript>` experience is complete and usable.
- **2G reality**: SSE connections are optional. The page loads with server-rendered content. If the connection supports SSE, live updates activate. If not, the user sees "Last updated: [time]" and can manually refresh.
- **Bandwidth budget**: Core HTML + CSS < 50KB gzip. JS adds up to 100KB. Images are lazy-loaded, SVG preferred, raster images only for complex diagrams and capped at 30KB each.

These are not contradictions once you accept progressive enhancement as the architecture. The floor is always usable; the ceiling is better when conditions allow.

### Risk 5: Budget and cost blindness

**Devil's advocate**: Continuous Claude sessions for research, brainstorming, building, and reviewing will consume API credits. The orchestrator can burn through an entire monthly budget in days if not constrained. The document has zero cost awareness.

**Mitigation**:

- **Research frequency cap**: Research runs at most once per discovery cycle (default 30 min). Not on every request. Results are cached aggressively (7 days for fast topics, 30 days for structural). The research engine checks cache BEFORE making any Claude call.
- **Build cost tracking**: The orchestrator already tracks Claude usage in the `claude_usage` table. The platform should log estimated token usage per research cycle and expose it in `/health/ready`.
- **Graceful degradation on budget exhaustion**: If the orchestrator hits rate limits, the platform keeps serving cached content. The dashboard shows "Research paused, showing data from [last update date]." The platform does not go down; it goes stale. Staleness is survivable; downtime is not.
- **Tiered research priority**: Not all research is equal. Job market data (directly actionable) runs every cycle. Policy updates (slow-moving) run weekly. Capability benchmarks (fast-moving but expensive to research) run every 3 days. This prevents budget waste on low-value refreshes.

### Risk 6: Scope creep via auto-discovery

**Devil's advocate**: Auto-discovery will keep finding "improvements" indefinitely. Without scope control, the orchestrator spends months perfecting audio accessibility while the core dashboard has no data. Or it keeps adding features nobody asked for while existing features are broken.

**Mitigation -- Phase gates** (see Build Order section below):

- Each phase has an explicit "done" criteria that must be met before auto-discovery can suggest work in the next phase
- Auto-discovery is constrained to the CURRENT phase's strategic areas until that phase's health checks pass
- The `idea.md` "Completed Features" section acts as the orchestrator's memory of what's done
- Phase transitions require ALL health checks for the current phase to pass, verified by `/health/ready`

### Risk 7: Auto-update pulls broken code, platform dies

**Devil's advocate**: The orchestrator commits code. The server cron pulls it. If the code is broken, PM2 restarts fail, and the platform is down until the next orchestrator cycle notices (could be 30+ minutes). With no SSH access, this is a real outage.

**Mitigation -- Three-stage deploy safety**:

1. **Pre-pull health snapshot**: Before `git pull`, the cron script records current health status. If the platform is healthy, proceed. If already unhealthy, skip the pull and log a warning (don't make it worse).

2. **Post-pull smoke test**: After `git pull` and `pnpm install`, the cron script runs `node src/server.js --smoke-test` (a flag that boots the app, checks DB migration, renders one page, and exits). If the smoke test fails, the cron script runs `git checkout HEAD~1` to revert to the previous commit and logs the failure.

3. **PM2 rollback**: PM2 is configured with `max_restarts: 3` and `restart_delay: 5000`. If the app crashes 3 times in a row, PM2 stops trying and the cron script's next run detects the dead process, reverts the last pull, and restarts.

4. **Orchestrator feedback loop**: The platform's `/health/ready` endpoint is checked by the orchestrator. If it returns non-200 for 2+ consecutive cycles, the orchestrator creates a critical-priority fix card. The fix card includes the last commit hash, the error from the health endpoint, and the PM2 error log.

**Worst case**: Platform is down for one cron cycle (5 minutes) before auto-revert kicks in. If auto-revert also fails, the orchestrator detects within 30 minutes and creates a fix card. Maximum realistic downtime: 35 minutes, fully automated recovery.

### Risk 8: Research sources break silently

**Devil's advocate**: APIs change. Websites block scrapers. Rate limits hit. A research source adapter returns empty data or errors, and the engine silently stops updating that category. Users see stale data presented as current.

**Mitigation**:

- **Source health tracking**: Each source adapter tracks its last successful fetch, last failure, failure count, and average response quality score. Stored in `research_source_health` table.
- **Staleness alerts**: If ANY research category has no successful update in 2x its expected refresh interval, the health endpoint degrades to a warning state, and the dashboard shows "Data for [category] is older than expected. Last updated: [date]."
- **Adapter redundancy**: Critical categories (job market, skill demand) have 2+ source adapters. If one breaks, the other continues. The scorer notes reduced confidence when fewer sources are available.
- **Failure escalation**: 3+ consecutive failures from a source → orchestrator gets an error log entry → self-healing creates a "fix [source] adapter" card.

### Risk 9: One bad recommendation destroys credibility

**Devil's advocate**: The platform recommends "Learn X, it's rising fast." X turns out to be a fad. Users who invested time feel betrayed. The platform becomes the noise it promised to filter.

**Mitigation**:

- **Corrections log**: A public, permanent, append-only log of every recommendation the platform has changed or retracted. Accessible at `/corrections`. Shows: what was recommended, when, what changed, why, what the new recommendation is. This is radical honesty applied to the platform's own mistakes.
- **Trend velocity warning**: Skills that rose quickly (< 3 months of data) are labeled "emerging, limited track record." Skills with 6+ months of consistent data are labeled "established trend." Users see the difference.
- **"We were wrong" policy**: When a recommendation is retracted, the correction appears prominently on the dashboard for one week. No silent edits. No pretending it didn't happen.
- **Conservative by default**: The platform's scoring algorithm weights longevity of trend data more than speed of rise. A skill that has been steadily growing for 6 months scores higher than one that spiked last week, even if the spike is larger. This inherently resists fads.

### Risk 10: The orchestrator runs forever but the world changes fundamentally

**Devil's advocate**: What if the AI landscape shifts so dramatically that the platform's entire STRUCTURE (tiers, skill clusters, pathway model) becomes wrong? Not just the data, but the framework for organizing the data.

**Mitigation**: This is why auto-discovery exists. Every 30 minutes, the orchestrator looks at the platform with fresh eyes. If the world changes so much that "tiers" stop making sense, auto-discovery should detect that the tier model is producing poor engagement or contradictory recommendations, and propose a structural refactor.

**Honest admission**: This is the weakest mitigation. Structural changes require human judgment. The platform will degrade gracefully (content stays correct even if organization is suboptimal) but cannot reinvent its own architecture. This is an acceptable limitation for v1. If it becomes a problem, it becomes a brainstorm card.

## Phase-Gated Build Order

The orchestrator MUST build in this order. Each phase has explicit "done" criteria. Auto-discovery is scoped to the current phase until its health checks pass.

### Phase 1: Foundation (Build First, Ship Immediately)

**Goal**: A working website on port 80 with seed data that is useful from day one.

**Build**:
- Express server with health endpoints
- SQLite schema (all tables above)
- Seed data loading on first boot
- Server-rendered landing page showing: tier selector, today's AI landscape snapshot (from seed), top 10 skills by demand
- Basic pathway view for Tier 2 (student) and Tier 3 (professional) using seed pathways
- autoconfig.sh for port 80 deploy
- PM2 config + cron auto-update script with rollback safety
- Structured error logging (orchestrator-compatible)

**Done when**: `/health/ready` returns 200 with `{ db: "ok", content: "seed", server: "ok" }`. A user can visit, select a tier, and see real (seed) content.

**Auto-discovery scope**: Server stability, deploy reliability, seed data quality.

### Phase 2: Research Engine (The Core Differentiator)

**Goal**: Live research replaces seed data. The platform starts being dynamic.

**Build**:
- Research engine with source adapters (start with 3-4 reliable, publicly accessible sources)
- Confidence scorer with cross-source validation
- URL verification for all research findings
- Freshness tracking + staleness detection
- Research results integrated into skill demand scores and dashboard
- Source health monitoring
- Dashboard showing live data (replacing seed data as research accumulates)

**Done when**: `/health/ready` returns `{ research: "live", sources_healthy: N, last_research: "<24h ago" }`. At least 3 source adapters returning data. Seed data being replaced by verified research.

**Auto-discovery scope**: New source adapters, research quality improvements, scorer tuning.

### Phase 3: Intelligence Layer (Make It Smart)

**Goal**: Dynamic skill graph, adaptive pathways, weekly digests, myth buster.

**Build**:
- Skill graph engine with dependency resolution
- Dynamic pathway generation (not just seed pathways)
- Pathway reordering based on research shifts
- Weekly digest auto-generation
- Myth buster (trending claims cross-checked against research)
- Corrections log
- Tier 4-5 data-dense dashboard view
- SSE for live updates (progressive enhancement)

**Done when**: Pathways update when research data changes. Weekly digest generates automatically. Corrections log is functional.

**Auto-discovery scope**: Pathway effectiveness, digest quality, skill graph accuracy, dashboard UX.

### Phase 4: Accessibility and Reach (Broaden the Audience)

**Goal**: Tier 0-1 experience, i18n, offline mode.

**Build**:
- Tier 0-1 minimal UI (separate pages, audio-first, icon-heavy)
- Hindi content (i18n framework + translated strings + translated skill descriptions)
- Browser TTS integration for Tier 0-1
- Service worker for offline content caching
- High contrast + dyslexia accessibility modes
- Performance optimization for 2G/old devices

**Done when**: Platform scores 90+ on Lighthouse accessibility. Hindi content available for Tier 0-1. Offline mode shows last-cached content.

**Auto-discovery scope**: Additional languages, audio quality, device testing, bandwidth optimization.

## Non-Goals (Explicitly Out of Scope)

- This is NOT a course platform. No video lectures, no certifications, no completion badges.
- This is NOT a job board. It tracks job market signals but does not list jobs.
- This is NOT a social platform. No comments, no profiles, no community features.
- This is NOT an AI tool itself. It guides people on using AI tools, but it is not trying to be one.
- This is NOT trying to replace formal education. It complements it with real-time market intelligence.
- No user accounts, no login, no personal data collection. Cookie-based preferences only, deletable anytime.

## Honest Limitations (What This Platform Cannot Do)

These are permanent architectural constraints, not bugs to fix.

1. **Research quality ceiling**: All research is performed by Claude in orchestrator sessions. Claude can access the web, but it cannot access paywalled content, private databases, or real-time streaming data. Job market analysis is based on publicly accessible signals, not comprehensive labor statistics. The platform is better than zero research, but worse than a dedicated human research team.

2. **Prediction is still prediction**: Even with real data, trend extrapolation is inherently uncertain. The platform can say "this skill's demand grew 40% in 6 months" (fact), but "this skill will continue growing" (prediction) is always a guess. The platform labels these differently, but users may still conflate them.

3. **Regional data gaps**: Job market and skill demand data is disproportionately available for the US, EU, and urban India. Rural India, Africa, Southeast Asia have sparse data. The platform will be less useful in data-sparse regions. It should say so explicitly rather than extrapolating from data-rich regions.

4. **No human verification loop**: With zero human intervention by design, there is no final check on research quality. The hallucination canary (Risk 2) catches some errors, but an AI checking another AI's work has known blind spots. The corrections log is the safety valve, not a prevention mechanism.

5. **Structural rigidity**: The tier model (0-5), skill cluster taxonomy, and pathway framework are designed by the orchestrator during Phase 1-3 builds. If the world changes so fundamentally that these structures become wrong, the platform will degrade gracefully but cannot redesign its own architecture. This requires a new brainstorm card with human-level judgment.

6. **No personalization beyond tier + domain**: Without user accounts, the platform cannot learn individual user preferences, track long-term progress, or adapt to specific learning styles. Cookie-based prefs are lost when cookies are cleared. This is a deliberate tradeoff: privacy over personalization.

## Completed Features

(None yet. This section will be populated as work completes. The orchestrator uses this to prevent duplicate work.)
