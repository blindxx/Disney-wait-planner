# Disney Wait Planner

A mobile-first Disney park planning app focused on fast decisions, low cognitive load, and clean UX.

Disney Wait Planner is intentionally built in disciplined, incremental phases to prevent scope creep and keep the experience focused.

The app answers two core questions:

- **What should I do right now?**
- **What am I planning to do today?**

---

## 🌐 Project Overview

Disney Wait Planner supports Disneyland Resort (DLR) and Walt Disney World (WDW). It combines live wait time data, personal plan management, Lightning reservation tracking, and deterministic conflict detection into a single mobile-first interface.

The system enforces a strict boundary between live data and local state. All matching is canonical and deterministic. There is no fuzzy logic.

---

## 🧠 Architecture Overview

Disney Wait Planner has evolved from a mock-only MVP into a real-time operational planner with a deterministic data boundary and safe fallback behavior.

### Data Flow

UI (Today / Wait Times)
→ `getWaitDataset({ resortId, parkId })`
→ Live provider (Queue-Times) OR Mock dataset

All wait-time data flows through:
`apps/web/src/lib/liveWaitApi.ts`

This guarantees:

- Unified data shape
- Deterministic status semantics
- Safe fallback to mock on failure
- Controlled refresh behavior
- No request storms

---

## 📁 Project Structure

This is a pnpm monorepo.

The frontend app lives in:
`apps/web`

Next.js App Router root:
`apps/web/src/app`

> **Critical:** The App Router is at `apps/web/src/app` — NOT `apps/web/app`.

Run locally with:

`pnpm install`
`pnpm --filter web dev`

Never run build/dev at the repo root without `--filter web`.

---

## 🧩 Shared Libraries

Key shared modules inside `apps/web/src/lib/`:

- `liveWaitApi.ts` — Unified wait data provider (live or mock)
- `plansMatching.ts` — Deterministic plan-to-attraction overlay matching
- `timeConflicts.ts` — Conflict detection for overlapping time ranges
- `normalizeAttractionName()` — Canonical name normalization engine

---

## 📡 Live Data System

Live waits are powered by the Queue-Times Real Time API via a server-side proxy:
`apps/web/src/app/api/waits/queue-times/route.ts`

### Why a Proxy?

- Avoids CORS issues
- Insulates UI from provider changes
- Enables cache control
- Prevents direct client dependency on third-party API

### Caching + Hydration

- 60s TTL with in-flight request deduplication
- `sessionStorage` used for fast tab hydration
- `localStorage` used for cross-session persistence
- UI reflects honest freshness state — no silent staleness

### Environment Variables

`NEXT_PUBLIC_WAIT_API_BASE_URL` (optional, defaults to same-origin proxy)

`NEXT_PUBLIC_WAIT_API_ENABLED=true`

- If false or unset → app runs mock-only
- If true → live data enabled

Live mode is enabled in Production via environment configuration.

---

## 🏗 Status Semantics

Operational states are deterministic and prioritized:

1. Planned closure (within ISO date range) → Closed
2. Live provider reports not operating → Down
3. Otherwise → Operating with wait time

Planned closures are ISO-driven and date-range enforced.
Display formatting is derived from ISO values (single source of truth).

---

## 🏰 Deterministic Matching Philosophy

All attraction matching across Plans, Lightning, and live overlay is deterministic. There is no fuzzy or probabilistic matching.

### Name Normalization

Live and mock attraction names may differ due to:

- Long-form titles
- Trademark symbols (™ ® ©)
- Unicode punctuation
- Dash variants
- Whitespace differences

The system includes:

- `normalizeAttractionName()` layer
- Alias mapping support
- Dev-only unmatched ride logger

This ensures live overlay remains resilient to provider drift.

### Resort Scoping

Alias maps are scoped per resort.
A name matched in DLR will never resolve to a WDW attraction.
There is no cross-resort matching.

---

## 🧠 Planner Data Model (Phase 8)

### Canonical Attraction Identity & Aliases

• UI always shows canonical name  
• Matching accepts aliases and variants  
• Handles API differences and renames  

Example: Rock 'n' Roller Coaster (Aerosmith → Muppets)

Rules:
• Never key logic off display names  
• Always resolve via normalization + alias mapping  

---

### Multi-Day Planning Model

• Plans use dayId (day-1, day-2)  
• Active day controls visible data  
• No cross-day leakage  

---

### Day-Scoped Lightning

• Lightning tied to specific day  
• Mirrors Plans behavior  

---

### Day-Aware Park Context

Priority:
1. Manual  
2. Auto (from plans)  
3. Fallback  

• Active day is authoritative  

---

### Import / Export Behavior

• Backup = full dataset  
• Import = active day only  
• Backward compatible  

---

## 🛡️ System Guarantees

The planner enforces strict deterministic behavior across all core systems.

### Stable Attraction Identity

• Attractions resolve to a single canonical identity  
• Aliases never create duplicates  
• Renames do not break existing data  

---

### No Cross-Day State Leakage

• Each day is fully isolated  
• Switching days cannot affect other days  

---

### Deterministic Matching

• Same input always resolves to same attraction  
• Independent of API formatting differences  

---

### Safe Sync Model

• Pull-before-push prevents overwrites  
• Sync gating prevents race conditions  

---

### Import Safety

• Invalid data is rejected  
• Legacy formats are normalized  
• No corruption of existing plans  

---

## 📋 Feature Summary

### Phase 1 — Wait Times

- Mobile-first ride cards
- Sorting + land filter
- Entertainment + planned closures
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
- TXT + CSV import
- Strict time normalization
- Deterministic overlay matching
- Canonical attraction + park label display
- Auto-sort by time
- Conflict detection (overlaps + invalid ranges)

### Phase 4 — Lightning

- Manual reservation tracking
- Shared countdown engine
- Deterministic bucket sorting
- Live wait overlay
- Canonical attraction display
- Inline edit mode (no clear+readd workflow)
- Conflict detection for reservation windows

### Phase 5 — Multi-Resort Expansion

- DLR + WDW structural support
- Scoped alias maps
- Resort + park persistence
- No cross-resort matching

### Phase 6 — Live Data + Hardening

- Queue-Times proxy integration
- 60s TTL + in-flight dedupe
- sessionStorage + localStorage hydration
- Honest freshness UI
- Canonical name normalization engine
- Shared `plansMatching.ts`
- Shared `timeConflicts.ts`
- Smart Entry Suggestions component
- Deterministic alias parity (DLR + WDW)

### Phase 7 — Profiles & Sync

• Multi-profile system with isolated storage namespaces  
• Profile switching (create, rename, delete)  
• Cloud sync with pull-before-push model  
• Sync readiness gating and conflict protection  

---

### Phase 8 — Multi-Day Planning & Data Model

• Multi-day planning system (day-based structure)  
• Day-scoped Plans and Lightning  
• Day-aware park context (manual + auto)  
• Import/export (backup vs single-day restore)  
• Canonical attraction identity + alias system  
• API naming resilience (rename-safe matching)  
• Strict day-scoped isolation with deterministic behavior guarantees  

---

## 🛠 Development Workflow

### Branch Discipline

- All development happens on feature branches
- Production deploys from `main` only
- Vercel generates preview deployments per branch

### pnpm Filter Usage

```bash
# Install dependencies
pnpm install

# Run dev server
pnpm --filter web dev

# Build
pnpm --filter web build

# Type check
pnpm --filter web tsc --noEmit
```

Never run build or dev at the repo root without `--filter web`.

---

## 🗺 Roadmap

### Phase 8 — Multi-Day Planning (Completed / In Progress)

Multi-day planning, Lightning, and park-aware systems.

---

### Phase 9 — Cross-Day Intelligence (Planned)

• Cross-day optimization  
• Smarter recommendations  
• Multi-day insights  
