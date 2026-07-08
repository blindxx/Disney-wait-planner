# AGENTS.md

## Repository expectations

- Next.js App Router lives in `apps/web/src/app`, not `apps/web/app`.
- Preserve existing architecture and avoid unrelated refactors.
- Prefer small, isolated fixes and phase-scoped changes.
- Run `pnpm --filter web build` before considering work complete.

## Review guidelines

When performing automated code reviews for this repository, prioritize detecting correctness and state-management issues over stylistic feedback.

Focus especially on:
- race conditions
- stale async responses
- hydration order problems
- client/server boundary mistakes (Next.js App Router)
- cloud sync correctness issues
- localStorage vs cloud state conflicts
- debounce lifecycle bugs
- stale state overwriting newer state

Important files frequently involved in state transitions:

apps/web/src/app/plans/page.tsx
apps/web/src/app/wait-times/page.tsx
apps/web/src/app/tom/page.tsx
apps/web/src/app/api/tom/ask/route.ts
apps/web/src/app/api/link-preview/route.ts
apps/web/src/lib/syncHelper.ts
apps/web/src/lib/liveWaitApi.ts
apps/web/src/app/api/sync/plans/route.ts

Ignore style-only feedback unless it affects correctness.

Prefer identifying production-impacting logic risks.

## Tom integration

### Architecture

Disney Wait Planner integrates with Project Tomorrow (Tom) through a server-side proxy.

Flow:

Browser
→ /api/tom/ask
→ Tom Railway API
→ Tom current-info engine

Never call the Tom Railway API directly from browser code.

### Environment variables

The following must remain server-only:

- TOM_API_URL
- TOM_API_KEY
- DWP_TOM_PROXY_KEY

Never expose these through `NEXT_PUBLIC_*`.

### API contract

Unless a phase explicitly changes it, preserve the existing `/api/tom/ask` request and response contract.

### Chat state

Tom chat currently supports:

- Local persistence (`dwp.tomChat.v1`)
- 24-hour expiration
- Legacy session migration from `dwp.tom.sessionId`
- New Chat
- Stale-response protection
- Anonymous sessions

Preserve this behavior unless a phase explicitly modifies chat state management.

### Link Preview service

`/api/link-preview` performs server-side metadata fetching.

Preserve:

- SSRF protections
- Redirect validation
- DNS validation
- Public-host validation
- Rate limiting
- HTTP/HTTPS-only previews
- Graceful fallback when metadata cannot be fetched

### Planner context

Planner-aware context is read-only.

Tom may read planner data supplied by Disney Wait Planner but must not modify planner data unless a future roadmap phase explicitly introduces planner write capabilities.

Preserve planner privacy and minimize transmitted data.
