# Disney Wait Planner

A mobile-first Disney park planning app focused on fast decisions, low cognitive load, and clean UX.

Disney Wait Planner is intentionally built in disciplined, incremental phases to prevent scope creep and keep the experience focused.

The app answers two core questions:

- **What should I do right now?**
- **What am I planning to do today?**

---

## 🧠 Architecture Overview

Disney Wait Planner is now a real-time operational planner with a deterministic data boundary and safe fallback behavior.

### Data Flow

UI (Today / Wait Times)  
→ `getWaitDataset({ resortId, parkId })`  
→ Live provider (Queue-Times) OR Mock dataset  

All wait-time data flows through:

