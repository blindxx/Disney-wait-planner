# Disney Wait Planner

A mobile-first Disney park planning app focused on fast decisions, low cognitive load, and clean UX.

Disney Wait Planner is intentionally built in disciplined, incremental phases to prevent scope creep and keep the experience focused.

The app answers two core questions:

- **What should I do right now?**
- **What am I planning to do today?**

---

## 🚦 Current Status

### ✅ Phase 1 — Wait Times (Complete)
- Mobile-first card layout
- Sorting (shortest / longest)
- Operating-only toggle
- Land filter
- Responsive tablet + desktop layout
- Mock wait time data only
- UI frozen until API phase

### ✅ Phase 2 — Today (Home) (Complete)
- Park selector (Disneyland / DCA)
- Current time indicator
- “Best options right now” list
- Down/Closed rides excluded from best list
- Clear visual hierarchy for fast scanning
- Primary action → View all wait times

### ✅ Phase 3.1 — My Plans (Manual Timeline MVP)
- Add activity (name required, optional time window)
- Edit activity
- Delete activity
- Reorder activities
- Mobile-safe bottom sheet (keyboard overlap fixed)

### 🚧 Phase 3.2 — Plan Import (Planned)

---

## 🧱 Tech Stack

- **Next.js 14** (App Router)
- **pnpm monorepo**
- **Tailwind CSS**
- **Vercel** (Preview deployments per branch, production from `main`)

---

## 📁 Project Structure

This is a pnpm monorepo.

The frontend app lives in:

