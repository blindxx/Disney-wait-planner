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

• Plans are day-scoped using a dayId (e.g. day-1, day-2)  
• Each day has an optional label and date  
• Active day controls which Plans and Lightning are visible  
• No cross-day leakage — switching days does not affect other days  
• Clear Day Plans removes all plan entries for the active day only  
• Clear All removes plans, lightning, and day metadata across all days  

---

### Day-Scoped Lightning

• Lightning reservations are tied to a specific day via dayId  
• Active day determines which Lightning entries are shown  
• Mirrors Plans behavior for isolation and clearing  
• Clear Day Lightning removes Lightning for the active day only  

---

### Day-Aware Park Context

Priority:
1. Manual — user-selected park overrides everything  
2. Auto — derived from the active day's plan entries  
3. Fallback — resort default  

• Active day is authoritative for park context resolution  
• Park context is stored per-day and preserved across backups  
• Auto/manual mode is persisted independently per day  

---

### Backup & Restore Behavior

Three export scopes are supported:

**Full Backup**
• Includes: Plans, Lightning, Days, day metadata, day park metadata  
• Restores the complete multi-day trip state  

**Plans Backup**
• Includes: Plans, Days, day metadata, day park metadata  
• Does not include Lightning  

**Day Export**
• Includes: Active day Plans and Lightning only  
• Scoped to the currently active day  

Restore behavior:
• Restore always opens Day 1 after import  
• Metadata preview is shown before confirming restore  
• Day park context is preserved across backup and restore  
• Backward compatibility is maintained for pre-Phase 8 backup formats  

---

### Cross-Day Intelligence

The system provides informational cross-day awareness. No automatic itinerary modification is performed.

**Duplicate Detection**
• Duplicate attraction detection across days  
• Duplicate Lightning detection across days  
• Park-aware duplicate grouping (same park only)  
• Resort-aware duplicate grouping (same resort only)  

**Conflict Detection**
• Lightning vs Plan conflict detection (same attraction, overlapping time)  
• Cross-day timing conflict detection for shared attraction windows  

**Visibility & Severity**
• Active-day visibility filtering — only active day entries appear in primary views  
• Duplicate severity indicators distinguish exact vs. probable duplicates  

These signals are informational only. The system surfaces conflicts and duplicates without modifying the itinerary.

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

### Phase 8 — Multi-Day Planning Platform

• Multi-day planning (day-labeled, date-stamped day structure)  
• Day-scoped Plans with Clear Day Plans and Clear All support  
• Day-scoped Lightning with Clear Day Lightning support  
• Day-aware park context (auto and manual modes, persisted per day)  
• Full Backup, Plans Backup, and Day Export scopes  
• Restore metadata preview and Day 1 restore behavior  
• Backward-compatible restore for pre-Phase 8 backup formats  
• Cross-day duplicate detection (attractions and Lightning)  
• Cross-day conflict detection (Lightning vs Plan, timing conflicts)  
• Active-day visibility filtering with duplicate severity indicators  
• Canonical attraction identity + alias system  
• API naming resilience (rename-safe matching)  
• Strict day-scoped isolation with deterministic behavior guarantees  
• Planner UX hardening across all day-aware flows  

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

### Phase 8 — Multi-Day Planning Platform (Complete)

• Multi-day planning (day-labeled, date-stamped structure)  
• Multi-day Lightning (day-scoped reservations)  
• Day-aware park context (auto/manual modes)  
• Full Backup, Plans Backup, and Day Export  
• Restore metadata preview and Day 1 restore behavior  
• Cross-day intelligence (duplicate and conflict detection)  
• Active-day visibility filtering  
• UX hardening across all day-aware flows  

---

### Phase 9 — Tomorrow Assistant Platform Integration (Planned)

• Architecture discovery for assistant integration  
• Shared intelligence layer across planner and assistant  
• Assistant integration for day-aware recommendations  
• Future Discord integration evaluation  

---

### Phase 10 — Advanced Trip Planning (Future)

• Trip templates for common park strategies  
• Plan sharing between users  
• Planning analytics and trip insights  
• Advanced strategy tools  
