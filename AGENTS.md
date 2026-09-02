# AGENTS.md

## Repository layout & commands

- This is a pnpm workspace (`apps/*`, `packages/*`). The web app lives in
  `apps/web`; shared types/mock data live in `packages/shared`.
- Next.js App Router lives in `apps/web/src/app`, not `apps/web/app`.
- Use filtered workspace commands rather than running app commands blindly
  at repo root:
  - `pnpm --filter web dev` — start the web app (port 3000)
  - `pnpm --filter web build` — production build; run before considering
    web app work complete
  - `pnpm --filter web start` — run a production build
  - `pnpm --filter @disney-wait-planner/shared typecheck` — typecheck the
    shared package
- There is no lint script, test runner, or CI-wired test suite in this repo
  today. Do not invent `test`/`lint` commands — if you add validation logic,
  follow the existing convention of dev-only `DEV_*_CASES` arrays (see
  `plansMatching.ts`, `plannedClosures.ts`) run manually from Node, not a
  test framework.
- Only document commands that actually exist in the relevant `package.json`.

## Scope discipline

- Prefer small, isolated, phase-scoped changes.
- Preserve existing architecture; do not restructure modules or introduce
  new abstractions to make a change "cleaner."
- No unrelated cleanup, refactors, or dependency upgrades bundled into a
  feature/fix change.

## Local-first + profile safety

Planner state (My Plans, Lightning Lane selections) is **local-first**:
localStorage is the source of truth, and cloud sync (when signed in)
mirrors it. Storage and sync state are **profile-scoped** — see
`apps/web/src/lib/profileStorage.ts` (namespaced keys `dwp:{profileId}:{baseKey}`)
and `apps/web/src/lib/syncHelper.ts` (debounced push, per-profile sync
status keys, `pullPlanner()`).

Invariants that must be preserved when touching this area:
- Scheduled/debounced work that has not yet started (e.g. a pending
  `scheduleSync()` timer) must be cancelled on relevant profile/auth
  transitions, not allowed to fire for a stale profile/session.
- An already-running, origin-scoped operation (e.g. an in-flight
  `doPush()` fetch) may finish safely rather than being aborted —
  `cancelScheduledSync()` clears the pending timer, not an in-flight
  fetch. Its results and status writes must remain tied to the profile
  captured when it started (`syncHelper.ts` captures `profileId` at
  push-start for exactly this reason), and completion from one
  profile/session must never mutate another profile's state.
- Preserve pull-before-push and stale-response protections around
  profile/auth transitions (e.g. `setSyncProfileId()` cancelling pending
  sync, `cancelScheduledSync()` on auth transitions, the caller pulling
  cloud state for a new profile before re-opening the sync gate).
- `/api/sync/planner` is the current combined (plans + Lightning) sync
  endpoint. For the `default` profile only, it falls back to reading the
  legacy plans-only data (`user_plans` table) directly whenever the
  combined row is missing or its `planner_json` fails to parse (no
  further shape/schema validation gates this fallback — syntactically
  valid but unexpected JSON, e.g. `null` or `{}`, does not trigger it),
  then write-through migrates/repairs it into combined storage — this
  fallback reads the legacy data itself, not the separate `/api/sync/plans`
  route. `/api/sync/plans` remains its own standalone legacy plans-only
  endpoint. Do not treat the legacy route as the primary sync path, and
  do not describe it as what `/api/sync/planner` calls internally.

## Planner identity / matching

Canonical attraction identity and alias resolution are shared behavior
used across live wait data and My Plans matching:
- `apps/web/src/lib/liveWaitApi.ts` — name normalization
  (`normalizeAttractionName`), resort alias maps (`ALIASES_WDW`,
  `ALIASES_DLR`), and canonical-identity dedupe for live Queue-Times data.
- `apps/web/src/lib/plansMatching.ts` — normalization (`normalizeKey`),
  tokenization, and alias maps (`ALIASES_DLR`/`ALIASES_WDW`) used to match
  user-entered plan text to attractions.
- `apps/web/src/lib/plannedClosures.ts` — closure entries keyed by
  `${parkId}:${normalizedAttractionName}`, matching `liveWaitApi.ts`'s
  normalization output.

Extend these existing matching/resolution paths when adding new naming
behavior rather than creating a feature-specific duplicate identity
system. When changing attraction identity or alias behavior, preserve
compatibility with import/export, cloud sync restore, and profile
duplication — those all depend on plan items continuing to resolve
against the same canonical identities over time.

## Wait/closure correctness

`apps/web/src/lib/liveWaitApi.ts`, `apps/web/src/lib/plannedClosures.ts`,
and the wait-times presentation layer are correctness-sensitive.

`plannedClosures.ts` deliberately splits two distinct concerns — do not
collapse them or use one in place of the other:
- `getClosureTiming()` — presentation only (whether a closure shows in the
  active Planned Closures list; permanent closures age out of this list
  after a retention window).
- `isClosureStatusEnforced()` — live status enforcement only (whether live
  wait data is forced to `CLOSED`). A permanent closure remains eligible
  for enforcement independent of whether it has aged out of the Planned
  Closures presentation — presentation lifecycle and enforcement
  eligibility are separate and must not be collapsed.

`liveWaitApi.ts` layers a sanity override on top of enforcement: when live
data clearly shows the ride operating (`is_open === true` and a positive
wait time), that credible live signal overrides closure enforcement rather
than being masked by it. Preserve this override when changing this area.

Fallthrough to Queue-Times live data is expected and correct whenever
`isClosureStatusEnforced()` is false (e.g. an UPCOMING closure that
hasn't started, or a TEMPORARY closure past its end date) — this is not
a bug. When changing this area, avoid regressions only where enforcement
is active: a known closure must not accidentally fall through to
Queue-Times and render as `DOWN`/`OPERATING` (misleading live status)
without going through the deliberate sanity override.

## Tom integration

### Architecture

Disney Wait Planner integrates with Project Tomorrow (Tom) through a
server-side proxy.

Flow:

Browser
→ `/api/tom/ask`
→ Tom Railway API
→ Tom current-info engine

Never call the Tom Railway API directly from browser code.

### Environment variables

The following must remain server-only:

- `TOM_API_URL`
- `TOM_API_KEY`
- `DWP_TOM_PROXY_KEY`

Never expose these through `NEXT_PUBLIC_*`.

### API contract

Unless a phase explicitly changes it, preserve the existing `/api/tom/ask`
request and response contract.

### Chat state

Tom chat persistence and stale-response protection are established
behavior — preserve them unless a phase explicitly modifies chat state
management. See `apps/web/src/app/tom/page.tsx` for current implementation
details before changing chat state handling.

### Link Preview service

`/api/link-preview` performs server-side metadata fetching. Preserve:

- SSRF protections (blocked private/loopback/link-local IP ranges, DNS
  validation, public-host validation)
- Redirect validation (each hop revalidated, hop count capped)
- HTTP/HTTPS-only previews
- Graceful fallback (URL validation, upstream fetch, and metadata parsing
  failures resolve 200 with null fields rather than an error status)
- Rate limiting — an intentional exception to the graceful fallback;
  returns HTTP 429 rather than the 200/null shape. Preserve both
  behaviors distinctly.

### Planner context

Planner-aware context passed to Tom (`planner_context` /
`plannerContextSnapshot.ts`) is **read-only**. Tom may read planner data
supplied by Disney Wait Planner but must not modify planner data unless a
future phase explicitly introduces planner write capabilities. Preserve
planner privacy and minimize transmitted data.

## Review guidance

When performing automated code reviews for this repository, prioritize
correctness and state-management issues over stylistic feedback.

Focus especially on:
- race conditions and stale async responses
- hydration order / client-server boundary mistakes (Next.js App Router)
- localStorage vs. cloud sync conflicts
- profile contamination (state, writes, or in-flight results leaking
  across profile or auth boundaries)
- debounce lifecycle bugs (timers not cancelled on profile/auth
  transitions, duplicate or reordered pushes)
- stale state overwriting newer state

Files frequently involved in state transitions:

- `apps/web/src/app/plans/page.tsx`
- `apps/web/src/app/wait-times/page.tsx`
- `apps/web/src/app/tom/page.tsx`
- `apps/web/src/app/api/tom/ask/route.ts`
- `apps/web/src/app/api/link-preview/route.ts`
- `apps/web/src/lib/syncHelper.ts`
- `apps/web/src/lib/profileStorage.ts`
- `apps/web/src/lib/liveWaitApi.ts`
- `apps/web/src/lib/plannedClosures.ts`
- `apps/web/src/app/api/sync/planner/route.ts`
- `apps/web/src/app/api/sync/plans/route.ts` (standalone legacy
  plans-only endpoint)

Ignore style-only feedback unless it affects correctness. Prefer
identifying production-impacting logic risks.
