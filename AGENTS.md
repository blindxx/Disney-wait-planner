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

## Deployment

- Canonical production origin: **`https://dwpapp.com`**. Vercel builds a
  preview deployment for every branch (see README Development section);
  those preview URLs are previews only and must not be treated as, or
  assumed to behave like, the canonical production origin.
- Production `NEXTAUTH_URL` is `https://dwpapp.com`. Production
  passwordless (magic-link) auth flows should return through this
  canonical production domain.
- Prefer configuration/environment variables (e.g. `NEXTAUTH_URL`) over
  hardcoding the production domain in application code.

### Database schema deployment order

`apps/web/src/lib/db-schema.sql` defines the Postgres schema the app
requires (NextAuth tables, `user_plans`, `user_planner`,
`user_planner_revision_seq`, `user_planner_writes`, `user_profiles`).
It's kept safely rerunnable (`CREATE ... IF NOT EXISTS` /
`ADD COLUMN IF NOT EXISTS`), so fresh setup and migrating an existing
database both go through the same file — never hand-write a separate
migration for a database that already has data in it.

The migration command is `pnpm --filter web run db:migrate` (the
`db:migrate` script in `apps/web/package.json`, which runs
`apps/web/scripts/migrate-db.mjs`). It reads the target database from the
`DATABASE_URL` environment variable, applies `db-schema.sql` in one
transaction, then verifies the objects the sync endpoints need exist with
the expected shape. It exits non-zero and prints `FATAL:` on any failure
(missing `DATABASE_URL`, connection failure, apply failure, or a
partial/incompatible schema) rather than passing silently.

Rules whenever a change touches `db-schema.sql` (e.g. adding a
column/table an endpoint depends on):

1. **Migrate before deploying.** A schema-dependent migration must run
   against the target database *before* the deployment that depends on it
   goes live. Application code must never be live against a database that
   lacks its schema — the sync endpoints have no fallback for missing
   schema and fail at runtime (e.g. code needing `user_profiles` reaching
   Production before its migration made `/api/sync/profiles` fail).
2. **Migrate every database in use.** Production and Preview must each be
   migrated whenever they use separate databases; migrating one does not
   cover the other.
3. **A failed migration or schema verification blocks deployment.** Do
   not deploy/promote until `db:migrate` exits successfully against that
   environment's database.
4. **Never expose or commit `DATABASE_URL`.** Supply it only via the
   shell environment for the run
   (`DATABASE_URL=<target DATABASE_URL> pnpm --filter web run db:migrate`);
   never write a real connection string into the repo, docs, logs, or
   commit messages.
5. Re-running `db:migrate` against an already-migrated database is safe
   and a no-op — re-run it if in doubt before a deploy.

Migrations are run manually; there is no automatic migration step in the
build or deploy pipeline.

## Scope discipline

- Prefer small, isolated, phase-scoped changes.
- Preserve existing architecture; do not restructure modules or introduce
  new abstractions to make a change "cleaner."
- No unrelated cleanup, refactors, or dependency upgrades bundled into a
  feature/fix change.

## Single maintained source of truth

When DWP already has an authoritative internal dataset/helper for a piece
of information, every feature needing that information must consume that
maintained source rather than recreate or independently maintain it.

Before adding new metadata, mappings, aliases, or status data, first
search the repo for an existing maintained source. Extend that source if
necessary rather than creating a parallel one.

This applies repo-wide, including canonical identity/aliases,
resort/park/land metadata, Attractions, Dining, Entertainment, planned
closures, lifecycle/status, and future Experiences/seasonal data.
Consumers may decide presentation, but must not fork the underlying
maintained truth.

## Local-first + profile safety

Planner state (My Plans, Lightning Lane selections) is **local-first**:
localStorage is the source of truth, and cloud sync (when signed in)
mirrors it. Storage is **profile-scoped**: authenticated planner content
is account + profile qualified (`dwp:{userId}:{profileId}:{baseKey}`),
while signed-out/unqualified storage is profile-scoped
(`dwp:{profileId}:{baseKey}`) — see `apps/web/src/lib/profileStorage.ts`,
and `apps/web/src/lib/syncHelper.ts` (debounced push, sync status keys,
`pullPlanner()`). See "Sync architecture invariants" below for the
isolation rules and what is and isn't account-isolated.

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
  profile/session must never mutate another profile/account's planner
  content or identity-scoped sync state. (The profile-keyed UI metadata
  `status`/`lastError`/`lastSyncedAt` is tied to the captured profile but
  is not account-isolated — see Sync architecture invariants.)
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

### Sync architecture invariants

- **Account + profile isolation.** Authenticated planner content is keyed
  by account *and* profile: server rows by `(user_id, profile_id)`, and
  authenticated local planner content/sync-baseline storage by
  account-qualified keys (`dwp:{userId}:{profileId}:{baseKey}`; see
  `profileStorage.ts`, `syncHelper.ts`). Signed-out storage remains
  device-local (`dwp:{profileId}:{baseKey}`). One account's or profile's
  planner content, and identity-scoped sync operations and their
  in-flight results (identity captured at operation start, cancellation
  on auth/profile transitions, ownership checks), must never be
  readable, writable, or pushable under another's identity. This
  guarantee does NOT extend to the display-only sync metadata
  `dwp:sync:{profileId}:status` / `lastError` / `lastSyncedAt`: it is
  keyed by profile ID only and is UI/coordination state, not
  account-isolated, so accounts sharing an ID (e.g. `default`) on one
  browser share it and it can persist across accounts. Do not read it as
  account-specific sync state.
  The per-profile local-content-owner marker (`getLocalContentOwner` /
  `setLocalContentOwner` in `syncHelper.ts`) is a separate case: its key
  is also profile-ID-only, but its *value* is the owning account's id —
  deliberate identity-attribution evidence about the legacy/unqualified
  namespace. It has exactly two write boundaries, each only after the
  content is durably written: a successful safe legacy adoption copy
  (`adoptLegacyProfileValueIfSafe`), and a genuine user-originated edit
  that durably commits to a legacy/unqualified key
  (`commitOrdinaryLocalEdit` in `syncHelper.ts`). A normal authenticated
  planner pull is NOT a write boundary: pulls write account-qualified
  storage, which the marker does not describe, so Plans/Lightning
  intentionally do not set it after a pull. Safe legacy adoption
  (`decideLegacyKeyAdoption` in `profileStorage.ts`) and the
  foreign-content checks rely on it to keep one account from adopting or
  pushing another account's local content. Treat it as account-specific
  evidence, not display state, and preserve these two write boundaries (never
  set it speculatively before content is durable, and never set it after
  an authenticated qualified pull).
- **Active profile is device-local.** `dwp.activeProfile` is never
  cloud-synced. Only what value it may point at is corrected, against the
  current account's visible profile list.
- **Planner sync protections.** `/api/sync/planner` + `syncHelper.ts` use
  server revisions with a client `baseRevision` (stale first-delivery
  writes are rejected with 409), client operation ids with a pending-op
  queue and replay/status lookup (`opStatuses`), a confirmed-baseline
  record per domain, conflict/recovery handling, and durable local-commit
  helpers. Do not bypass these with direct localStorage writes or
  unconditional pushes; pull-before-push and destructive-first-sync
  prevention still apply.
- **Profile registry is separate.** `user_profiles` (via
  `/api/sync/profiles`, reconciled client-side by `profileRegistrySync.ts`)
  syncs profile *identity metadata* (id + name) across an account's
  devices. It never carries planner content and has no
  revision/pending-op machinery. Profile deletion is NOT synchronized:
  no code path sets `deleted_at` and there is no delete endpoint, so a
  delete stays device-local, recorded per account on that device
  (`markProfileLocallyDeleted` in `profileStorage.ts`) to keep it from
  being re-discovered there. The `deleted_at` column and the
  tombstone-aware read/adoption logic are groundwork only — never
  document or rely on them as a cross-device delete path. Planner network sync
  and registry reconciliation are separate endpoints/systems with
  independent revision/reconciliation machinery — neither calls into the
  other's sync path. They are not fully decoupled, though: safe legacy
  adoption intentionally consults profile-registry provenance
  (`isProfileUnclaimedByOtherAccount` over the local registry state) plus
  the current user's ownership for cross-account safety; preserve that. Registry adoption is
  additive: a server-known id (active or tombstoned) is never overwritten
  or resurrected by a stale local copy, and a local id owned by a
  different account on this device is not adopted — except the canonical
  shared `default` profile (`CANONICAL_SHARED_PROFILE_ID` in
  `profileStorage.ts`), which is exempt from that cross-account
  exclusion: every account legitimately has its own `default`, so one
  account's registration of it must never block another's. Its planner
  content stays isolated by account + profile like any other id.
- **Root authenticated-lifecycle guards.** `SessionProviderWrapper.tsx`
  (mounted once in the root layout, before page children) owns the
  global, page-independent *baseline* authenticated lifecycle: correcting
  the active profile (`ensureActiveProfileVisible`), safe legacy adoption
  of unqualified local data into account-qualified keys
  (`adoptLegacyProfileValueIfSafe`), and starting registry
  reconciliation. While the session status is `loading` (unresolved
  identity), active-profile correction, legacy adoption, and
  reconciliation startup are all withheld, but the registry identity is
  still cleared (`setRegistryIdentity(null)`) so an in-flight
  reconciliation round from the prior account stops at its next
  currency check. Some page-level calls are intentional supplements, not
  duplicates, and must be kept: Plans/Lightning also call
  `adoptLegacyProfileValueIfSafe` (idempotent, safe to repeat) as part of
  retargeting their own storage identity, and Settings also calls
  `reconcileProfileRegistry` for a prompt UI refresh. Do not remove them
  on the assumption the root guards cover them; do not add new baseline
  lifecycle behavior to a single page — put it in the root guards.
- **Legacy compatibility.** Pre-account local data (unqualified keys,
  legacy `dwp.myPlans`-style values) and legacy server plans remain
  adoptable/readable only through the existing safe-adoption and
  fallback paths above, subject to the same isolation rules.
- Schema for all of the above lives in `db-schema.sql`; see Database
  schema deployment order.

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

## Catalog taxonomy

- DWP's curated catalogs (Attractions, Dining, Entertainment, Experiences)
  are intentional product subsets, not mirrors of provider taxonomy or
  content. Provider entities (ThemeParks.wiki, Queue-Times) must not
  automatically become DWP catalog entries.
- Phase 12 convention (subject to reassessment after Phase 12):
  **Attraction** = a queue/repeating-cycle experience generally available
  throughout operating hours; **Entertainment** = a discrete scheduled
  performance where showtime is the useful planning constraint. An entry
  lives in exactly one active catalog — no duplicate active identities.
- Character meets and roaming entertainment stay excluded from the curated
  Entertainment catalog unless explicitly approved as exceptions.
- Provider-discovered content may be preserved (e.g. the `providerOnly`
  report) for broader/future catalog experiences without automatically
  entering curated planner/Smart Entry surfaces.
- Do not introduce a subjective "plan-worthy" inclusion rule.

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

### Planned-closure data-maintenance scope

`plannedClosures.ts`'s manually maintained dataset is not intended to
mirror every routine Disney refurbishment or temporary maintenance
closure — it exists for closures that matter for trip planning:
- Generally prioritize extended/multi-month closures.
- Routine short-term maintenance closures of roughly a month or less
  normally should not be added.
- This is guidance, not a rigid duration cutoff — an unusually
  significant short closure may still warrant an entry when there is a
  clear trip-planning reason.
- A short closure that isn't manually maintained still surfaces
  correctly through the normal live/provider status path
  (`liveWaitApi.ts`) while it's happening; it doesn't need a
  `plannedClosures.ts` entry to be represented.
- Future catalog/data-maintenance audits should apply this guidance
  rather than proposing every short refurbishment as a planned-closure
  data update.

## ThemeParks.wiki provider

- `apps/web/src/lib/themeParksApi.ts` is the only ThemeParks.wiki client
  (server-side; never call the provider from browser code). Queue-Times
  remains the attraction wait provider; the DWP catalog remains canonical
  identity/metadata authority. ThemeParks UUIDs
  (`themeParksProviders.ts`) are integration metadata only.
- Never fabricate schedules/showtimes: valid-empty is `ok` with empty
  arrays, failure is a typed error; stale-if-error data is flagged.
- Any UI showing ThemeParks.wiki data renders `ThemeParksAttribution`.
- `getChildren(id)` (`/entity/{id}/children`, static 6h cache) is the
  identity-discovery source — `/live` omits dormant/seasonal entities.
- DWP Entertainment → ThemeParks UUID mapping lives only in
  `themeParksEntertainmentMapping.ts`: explicit, park-qualified (names repeat
  across parks), every active Entertainment entry mapped or intentionally
  unmapped with a reason, no runtime name-based remapping. Drift surfaces via
  `verifyEntertainmentMapping()` findings; provider-only SHOW entities are
  preserved in its `providerOnly` report, never auto-added to DWP catalogs.
- Park hours (Phase 12.4): ThemeParks `getSchedule()` → `parkHours.ts`
  (pure normalizer/display) → `parkHoursService.ts` → `/api/park-hours`.
  `OPERATING` is the park window; other schedule types are preserved and only
  labelled with the provider's own `description` (never inferred from `type`).
  `Closed` is derived only when provider data safely brackets the date (see
  `parkHours.ts` header); absence of `OPERATING` alone is `unknown`, shown as
  "Unavailable". Monthly follow-up requests happen only for potential closures.
  DEV checks: `runDevParkHoursCases()` / `runDevParkHoursServiceCases()`.
- DEV checks: `runDevThemeParksProviderCases()` /
  `runDevThemeParksApiCases()` /
  `runDevThemeParksEntertainmentMappingCases()` (run manually; return failing
  labels).

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
- `DWP_CATALOG_API_KEY`

Never expose these through `NEXT_PUBLIC_*`.

### API contract

Unless a phase explicitly changes it, preserve the existing `/api/tom/ask`
request and response contract.

### Catalog query API

`GET /api/catalog/query` is the read-only, server-to-server catalog query
contract DWP exposes for Tom (see `apps/web/src/lib/catalogQuery.ts` for the
full contract and `apps/web/src/app/api/catalog/query/route.ts` for
auth/transport). DWP is the authoritative source for stable canonical
planner/catalog metadata (canonical identity/name, type, resort, park, land,
active vs. legacy lifecycle); Tom owns natural-language question
understanding and must translate a question into structured filters
(`name`/`type`/`resort`/`park`/`land`) before calling this route — DWP must
never inspect/parse Tom's natural-language question itself.

Preserve:

- Auth via the `x-dwp-catalog-api-key` header, checked against
  `DWP_CATALOG_API_KEY` with a timing-safe comparison — always required
  (unlike `/api/tom/ask`'s optional admin-only key), since this route has no
  legitimate unauthenticated/browser caller.
- Active-only results. Legacy (permanently closed/replaced) identities
  remain recognition/history-only for old saved plans and must never appear
  in normal catalog query results.
- Single-source-of-truth reuse: every result is read from the existing
  per-domain active catalogs and their existing alias/canonical resolvers
  (`mockAttractionWaits`/`legacyAttractions.ts`, `diningSuggestions.ts`,
  `entertainmentSuggestions.ts`, `experienceSuggestions.ts`). Extend those
  sources when metadata is missing — never fork a parallel catalog/alias/
  location table into this module.
- No free-text search, no writes, no natural-language parsing.

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

Recognized plan items in `planner_context.plans` carry optional
`park`/`land` fields (see `PlannerContextSnapshotItem` in
`plannerContextSnapshot.ts`), resolved through the same canonical
`getPlannerItemMetadata` infrastructure My Plans itself uses — never a
separate inference table. Both are additive/optional: an item with no
resolvable catalog identity or resort context simply omits them rather than
guessing, and existing Tom versions that don't read these fields are
unaffected.

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
