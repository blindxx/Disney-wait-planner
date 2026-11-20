/**
 * GET /api/cron/snapshot-probe?trigger=<id> — TEMPORARY scheduler diagnostic.
 *
 * Vercel Cron → this route → GitHub `workflow_dispatch` of
 * `.github/workflows/snapshot-writeback-probe.yml` → that workflow writes
 * `probe/result.json` on the isolated `test/snapshot-writeback` branch.
 *
 * Fails CLOSED like the other cron routes (CRON_SECRET unset → 500, bad header → 401,
 * both before any outbound call). A 200 here means ONLY that GitHub accepted the dispatch
 * (HTTP 204); it says nothing about whether the workflow ran or the writeback succeeded —
 * check the Actions run and probe/result.json for that. No lifecycle audit API call is made.
 * Env (server-only): CRON_SECRET, GITHUB_PROBE_DISPATCH_TOKEN. Remove after testing (README).
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeCronRequest } from "../../../../lib/parkHoursRefresh";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const REPO = "blindxx/Disney-wait-planner";
const WORKFLOW_FILE = "snapshot-writeback-probe.yml";
/** workflow_dispatch needs the workflow file on this ref; fixed so the route can never dispatch another branch. */
const DISPATCH_REF = "main";
const TRIGGER_IDS = new Set(["est-11am", "est-12pm", "est-1pm"]);

export async function GET(request: NextRequest) {
  const auth = authorizeCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth === "unconfigured") return NextResponse.json({ error: "Cron is not configured" }, { status: 500, headers: NO_STORE });
  if (auth === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const triggerId = request.nextUrl.searchParams.get("trigger") ?? "";
  if (!TRIGGER_IDS.has(triggerId)) return NextResponse.json({ error: "Unknown trigger" }, { status: 400, headers: NO_STORE });

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
        "User-Agent": "dwp-snapshot-probe",
      },
      body: JSON.stringify({ ref: DISPATCH_REF, inputs: { trigger_id: triggerId, dispatched_at: dispatchedAt } }),
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
      triggerId,
      dispatchedAt,
      dispatch: accepted ? "accepted" : "failed",
      githubStatus: status,
      workflowResult: "unknown — verify the Actions run and probe/result.json on test/snapshot-writeback",
    },
    { status: accepted ? 200 : 502, headers: NO_STORE },
  );
}
