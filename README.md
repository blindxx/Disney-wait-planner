# Disney Wait Planner

A mobile-first Disney park planning app focused on fast decisions, low cognitive load, and clean UX. Disney Wait Planner pairs live attraction wait times with a local-first, multi-day trip planner — and Tom, a built-in assistant that can answer Disney questions and read-only questions about what you've planned.

---

## 🌐 Overview

Disney Wait Planner supports Disneyland Resort (DLR) and Walt Disney World (WDW). It combines live attraction wait times, a multi-day trip planner (attractions, dining, entertainment, and custom entries), Lightning Lane tracking, and a built-in assistant (Ask Tom) into a single mobile-first interface.

The system enforces a strict boundary between live data and local planner state, and all attraction/plan matching is canonical and deterministic — there is no fuzzy logic.

---

## ✨ Features

### Today & Wait Times

- Live attraction wait times for DLR and WDW, with a resort/park selector
- Deterministic status handling: planned closures take priority, then live "not operating" status, then a live wait time
- Planned closures are lifecycle-aware — temporary refurbishments (with a known end date or open-ended) and permanent closures are tracked and displayed distinctly, with permanent closures aging out of the active list over time
- Mobile-first ride cards with sorting and land filtering
- Entertainment showtimes, including multi-showtime events

### My Plans

- Manual, day-scoped itinerary builder across attractions, dining, entertainment, and custom entries
- Smart Entry suggestions for known attractions, dining locations, and entertainment, with automatic type detection; unmatched names fall back to a manual type selector
- Multi-day planning with per-day labels/dates, and day-scoped Lightning Lane reservations
- Day-aware park context (auto-derived from your plans, or manually overridden)
- TXT/CSV import, plus three export/restore scopes — **Full Backup** (all days, Plans and Lightning Lane), **Plans Backup** (all days, Plans only), and **Day Export** (just the active day's Plans and Lightning Lane) — with a metadata preview shown before restoring
- Cross-day duplicate detection (attractions and Lightning Lane) and conflict detection (overlapping times, Lightning Lane vs. plan conflicts), shown as informational signals — the app never modifies your itinerary automatically

### Lightning Lane

- Manual Lightning Lane reservation tracking, day-scoped alongside My Plans
- Live countdown and deterministic bucket sorting, with live wait overlay and inline editing

### Profiles & Sync

- Multiple local profiles with isolated storage
- Optional sign-in with cloud sync (pull-before-push, so cloud data is never silently overwritten)

### Ask Tom

Tom is Disney Wait Planner's built-in assistant. Tom can:

- Answer general Disney questions — parks, lands, attractions, dining, entertainment, and news
- Answer supported wait time questions
- Answer **Planner Insights** questions: read-only, planner-aware questions and analytics about your local trip planner — what you have planned, conflicts, repeats, park assignments, and simple analytics like "which day has the most planned"
- Hold a conversation, including natural follow-up questions

Tom does **not** edit your plans, generate or optimize itineraries, reason about transportation or travel time, or make predictions/recommendations it isn't designed to support. Planner data shared with Tom is a compact, read-only summary — Tom cannot write back to your planner. See the in-app **Tom Help Guide** (`/tom/help`, linked from the Ask Tom Help modal) for the full, current list of what Tom can do.

---

## 📡 Live Data

Live attraction wait times are powered by the Queue-Times API, accessed through a server-side proxy rather than called directly from the browser. All wait data flows through a single unified path (`liveWaitApi.ts`), which returns the same shape regardless of source and falls back to a mock dataset if live data is disabled or unavailable — so the UI never breaks on a live-data outage.

---

## 🏗 Architecture

- **Next.js (App Router) + TypeScript**, in a **pnpm monorepo** (`apps/*`, `packages/*`)
- Deployed on **Vercel** (see Development below for branch/deploy workflow)
- Planner state (My Plans, Lightning Lane) is **local-first**: `localStorage` is the source of truth, and cloud sync mirrors it when signed in
- Live wait data is unified behind a single provider path (see Live Data above)
- Tom is integrated through a server-side proxy (`/api/tom/ask`) to the Tom Railway API — Tom credentials are never exposed to the browser
- All attraction/plan name matching goes through a shared canonical normalization + alias layer, so live data, My Plans, Lightning Lane, and planned closures stay in sync despite provider naming differences

For implementation-level invariants, data flow details, and correctness constraints, see [`AGENTS.md`](./AGENTS.md).

---

## 📁 Project Structure

This is a pnpm workspace:

- `apps/web` — the Next.js frontend app
- `packages/shared` — shared types and mock data

The Next.js App Router lives at `apps/web/src/app` (not `apps/web/app`).

---

## 🛠 Development

Development happens on feature branches; `main` is the production branch, and Vercel builds a preview deployment for every branch.

```bash
# Install dependencies
pnpm install

# Run the web app locally (http://localhost:3000)
pnpm --filter web dev

# Production build
pnpm --filter web build

# Run a production build
pnpm --filter web start

# Type-check the shared package
pnpm --filter @disney-wait-planner/shared typecheck
```

Never run `dev`/`build` at the repo root without `--filter web` — the monorepo root has no app of its own to run.

### Environment Variables

**Live wait data**

- `NEXT_PUBLIC_WAIT_API_ENABLED` — `true` to enable live wait data; unset or `false` runs the app mock-only
- `NEXT_PUBLIC_WAIT_API_BASE_URL` — optional override for the wait API base URL; defaults to the same-origin proxy

**Authentication & sync** (optional; required for sign-in and cloud sync)

- `NEXTAUTH_URL` — canonical app URL (e.g. `https://your-app.vercel.app`)
- `NEXTAUTH_SECRET` — random secret (`openssl rand -base64 32`)
- `DATABASE_URL` — Postgres connection string used by the auth adapter and sync
- `EMAIL_SERVER`, `EMAIL_FROM` — email provider settings for magic-link sign-in

**Ask Tom** (server-only — never expose these as `NEXT_PUBLIC_*`)

- `TOM_API_URL` — Tom Railway API base URL
- `TOM_API_KEY` — Tom Railway API key
- `DWP_TOM_PROXY_KEY` — shared secret used by the server-side Tom proxy

---

## 🧭 Contributing

See [`AGENTS.md`](./AGENTS.md) for repository conventions, scope discipline, and the correctness invariants (local-first/profile safety, canonical attraction identity, planned-closure enforcement, and Tom's read-only planner integration) that must be preserved when touching those areas.
