# AGENTS.md
## Repository expectations
- Next.js App Router lives in `apps/web/src/app`, not `apps/web/app`.
- Preserve existing architecture and avoid unrelated refactors.
- Prefer small, isolated fixes and phase-scoped changes.
- Run `pnpm --filter web build` before considering work complete.
## Review guidelines
When performing automated code reviews for this repository, prioritize detecting correctness and state-management issues over stylistic feedback.
Focus especially on:
• race conditions
• stale async responses
• hydration order problems
• client/server boundary mistakes (Next.js App Router)
• cloud sync correctness issues
• localStorage vs cloud state conflicts
• debounce lifecycle bugs
• stale state overwriting newer state
Important files frequently involved in state transitions:
apps/web/src/app/plans/page.tsx
apps/web/src/app/wait-times/page.tsx
apps/web/src/lib/syncHelper.ts
apps/web/src/lib/liveWaitApi.ts
apps/web/src/app/api/sync/plans/route.ts
Ignore style-only feedback unless it affects correctness.
Prefer identifying production-impacting logic risks.
