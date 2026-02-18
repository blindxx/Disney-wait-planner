# Disney Wait Planner

A mobile-first Disney park planning app focused on fast decisions, low cognitive load, and clean UX.

Disney Wait Planner is intentionally built in disciplined, incremental phases to prevent scope creep and keep the experience focused.

The app answers two core questions:

- **What should I do right now?**
- **What am I planning to do today?**

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

## 📡 Live Data System

Live waits are powered by the Queue-Times Real Time API via a server-side proxy:  
`apps/web/src/app/api/waits/queue-times/route.ts`

### Why a Proxy?

- Avoids CORS issues  
- Insulates UI from provider changes  
- Enables cache control  
- Prevents direct client dependency on third-party API  

### Environment Variable
NEXT_PUBLIC_WAIT_API_BASE_URL (optional, defaults to same-origin proxy)

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

## 🏰 Name Matching & Canonical Identity

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

---

## 📁 Project Structure

This is a pnpm monorepo.

The frontend app lives in:  
`apps/web`

Next.js App Router root:  
`apps/web/src/app`

Run locally with:

`pnpm install`  
`pnpm --filter web dev`

Never run build/dev at the repo root without `--filter web`.
