# Disney Wait Planner

A mobile-first Disney park planning app focused on fast decisions, low cognitive load, and clean UX.

The app answers two core questions:

- What should I do right now?
- What am I planning to do today?

---

## Project Overview

Disney Wait Planner is a real-time operational planner for Disneyland Resort (DLR) and Walt Disney World (WDW). It combines live wait time data with personal plan management, Lightning reservation tracking, and intelligent conflict detection. The system is built in disciplined, incremental phases to prevent scope creep and maintain a focused user experience.

---

## Architecture Overview

### Monorepo Structure

This is a pnpm monorepo. The active application is `apps/web`.

```
Disney-wait-planner/
  apps/
    web/                  # Next.js 14 App Router application
      src/
        app/              # App Router root (pages, layouts, API routes)
        lib/              # Shared utilities and data logic
        components/       # UI components
  packages/               # Shared packages (if applicable)
```

**Critical path note:** The Next.js App Router lives at `apps/web/src/app`. Not `apps/web/app`.

### apps/web

- Framework: Next.js 14, App Router
- Hosting: Vercel
- Preview deployments per branch; production deploys from `main`

### Shared Libraries

Key shared modules inside `apps/web/src/lib/`:

| Module | Purpose |
|---|---|
| `liveWaitApi.ts` | Unified wait data provider (live or mock) |
| `plansMatching.ts` | Deterministic plan-to-attraction overlay matching |
| `timeConflicts.ts` | Conflict detection for overlapping time ranges |
| `normalizeAttractionName()` | Canonical name normalization engine |

---

## Feature Summary

### Phase 1 — Wait Times

- Mobile-first ride cards
- Sorting and land filter
- Entertainment and planned closures
- Multi-time show support

### Phase 2 — Today

- Park selector
- Current time indicator
- Best options logic
- Live-aware dataset integration
- Resort toggle (DLR / WDW)
- Park selector scoped per resort

### Phase 3 — My Plans

- Manual timeline builder
- TXT and CSV import
- Strict time normalization
- Deterministic overlay matching
- Canonical attraction and park label display
- Auto-sort by time
- Conflict detection (overlaps and invalid ranges)

### Phase 4 — Lightning

- Manual reservation tracking
- Shared countdown engine
- Deterministic bucket sorting
- Live wait overlay
- Canonical attraction display
- Inline edit mode (no clear-and-readd workflow)
- Conflict detection for reservation windows

### Phase 5 — Multi-Resort Expansion

- DLR and WDW structural support
- Scoped alias maps
- Resort and park persistence
- No cross-resort matching

### Phase 6 — Live Data + Hardening

- Queue-Times proxy integration
- 60s TTL with in-flight dedupe
- sessionStorage and localStorage hydration
- Honest freshness UI
- Canonical name normalization engine
- Shared `plansMatching.ts`
- Shared `timeConflicts.ts`
- Smart Entry Suggestions component
- Deterministic alias parity (DLR and WDW)

---

## Deterministic Matching Philosophy

All attraction matching across features (Plans, Lightning, live overlay) is deterministic. There is no fuzzy or probabilistic matching.

The system uses a canonical name normalization layer to handle provider drift:

- Long-form vs. short-form titles
- Trademark symbols (TM, R, C)
- Unicode punctuation variants
- Dash and whitespace differences

Alias maps are scoped per resort. There is no cross-resort matching. A name matched in DLR will never incorrectly resolve to a WDW attraction.

Operational status follows a strict priority order:

1. Planned closure (within ISO date range) → Closed
2. Live provider reports not operating → Down
3. Otherwise → Operating with wait time

Planned closures are ISO-driven and date-range enforced. Display formatting derives from ISO values as a single source of truth. A dev-only unmatched ride logger assists in maintaining alias parity during provider updates.

---

## Live Data Architecture

Live wait times are powered by the Queue-Times Real Time API via a server-side proxy:

```
apps/web/src/app/api/waits/queue-times/route.ts
```

All wait-time data flows through:

```
apps/web/src/lib/liveWaitApi.ts
```

### Why a Proxy

- Avoids CORS issues
- Insulates the UI from provider changes
- Enables cache control
- Prevents direct client dependency on a third-party API

### Caching and Hydration

- 60-second TTL with in-flight request deduplication
- sessionStorage used for fast tab hydration
- localStorage used for cross-session persistence
- UI reflects honest freshness state (no silent staleness)

### Environment Configuration

| Variable | Behavior |
|---|---|
| `NEXT_PUBLIC_WAIT_API_ENABLED=true` | Live data enabled |
| Unset or `false` | App runs mock-only |

Live mode is enabled in production via Vercel environment configuration.

---

## Development Workflow

### Branch Discipline

- All development happens on feature branches
- Production deploys from `main` only
- Vercel generates preview deployments per branch

### Running Locally

```bash
pnpm install
pnpm --filter web dev
```

Never run build or dev at the repo root without `--filter web`.

### Useful pnpm Commands

```bash
# Run dev server
pnpm --filter web dev

# Build the web app
pnpm --filter web build

# Type check
pnpm --filter web tsc --noEmit
```

---

## Roadmap

### Phase 7 — Settings + Sync

User preferences, persistent configuration, and optional account-based sync.

### Phase 8 — Multi-Day Planning

Support for planning across multiple park days within a single trip.
