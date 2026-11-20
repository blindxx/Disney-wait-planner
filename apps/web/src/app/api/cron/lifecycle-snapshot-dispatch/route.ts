/**
 * GET /api/cron/lifecycle-snapshot-dispatch — Vercel Cron → GitHub `workflow_dispatch` of the
 * existing `.github/workflows/lifecycle-audit-snapshot.yml` on `main`.
 *
 * Dispatch only: all snapshot processing, validation, completeness handling, concurrency and the
 * writeback to `lifecycle-audit-snapshot` stay in that workflow. Same pattern as `snapshot-probe`.
 *
 * Fails CLOSED like the other cron routes (CRON_SECRET unset → 500, bad header → 401, both before
 * any outbound call). A 200 means ONLY that GitHub accepted the dispatch (HTTP 204); it says nothing
 * about whether the workflow ran or succeeded — check the Actions run. No lifecycle audit API call here.
 * Env (server-only): CRON_SECRET, GITHUB_PROBE_DISPATCH_TOKEN.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeCronRequest } from "../../../../lib/parkHoursRefresh";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const REPO = "blindxx/Disney-wait-planner";
const WORKFLOW_FILE = "lifecycle-audit-snapshot.yml";
/** Fixed so the route can never dispatch another workflow or branch. */
const DISPATCH_REF = "main";

export async function GET(request: NextRequest) {
  const auth = authorizeCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth === "unconfigured") return NextResponse.json({ error: "Cron is not configured" }, { status: 500, headers: NO_STORE });
  if (auth === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const token = process.env.GITHUB_PROBE_DISPATCH_TOKEN;
  if (!token) return NextResponse.json({ error: "Dispatch credential is not configured" }, { status: 500, headers: NO_STORE });

  const dispatchedAt = new Date().toISOString();
  let status: number | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "dwp-lifecycle-snapshot-dispatch",
      },
      body: JSON.stringify({ ref: DISPATCH_REF }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    status = res.status;
  } catch {
    status = null; // network/timeout; no error text echoed
  }

  const accepted = status === 204;
  return NextResponse.json(
    {
      dispatchedAt,
      workflow: WORKFLOW_FILE,
      ref: DISPATCH_REF,
      dispatch: accepted ? "accepted" : "failed",
      githubStatus: status,
      workflowResult: "unknown — verify the 'Lifecycle audit snapshot' Actions run (workflow_dispatch event)",
    },
    { status: accepted ? 200 : 502, headers: NO_STORE },
  );
}
