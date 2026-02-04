# Disney Wait Planner

A personal Disney Parks planning tool that combines custom itineraries with live attraction wait times to suggest smarter day-of decisions.

## Project Structure

```
apps/
  web/      # Next.js frontend (port 3000)
  api/      # Express backend (port 4000)
packages/
  shared/   # Shared types and utilities
```

## Prerequisites

- Node.js 18+
- pnpm 8+

## Setup

```bash
# Install pnpm if you haven't already
npm install -g pnpm

# Install all dependencies
pnpm install
```

## Development

Run both the web app and API server together:

```bash
pnpm dev
```

This starts:
- Web app at http://localhost:3000
- API server at http://localhost:4000

### Health Check

```bash
curl http://localhost:4000/health
```

## Individual Apps

Run apps separately if needed:

```bash
# Web only
pnpm --filter @disney-wait-planner/web dev

# API only
pnpm --filter @disney-wait-planner/api dev
```

## Tech Stack

- **Frontend**: Next.js 14 with App Router, TypeScript
- **Backend**: Express, TypeScript
- **Monorepo**: pnpm workspaces
