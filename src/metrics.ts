import type { Context } from "hono";

import { timingSafeEqual } from "./oauth";
import type { AppEnv } from "./types";

export function trackEvent(env: AppEnv["Bindings"], event: string, ...blobs: string[]): void {
  try {
    env.METRICS.writeDataPoint({ blobs: [event, ...blobs], indexes: [event] });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Failed to write metric",
        event,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

// Skips events entirely for requests from an allowlisted internal IP (e.g. founders' own
// traffic), so it never inflates the funnel numbers. The IP itself is only compared in
// memory for this check and is never written to the metrics dataset.
export function trackRequestEvent(env: AppEnv["Bindings"], request: Request, event: string, ...blobs: string[]): void {
  if (isInternalRequest(env, request)) return;
  trackEvent(env, event, ...blobs);
}

function isInternalRequest(env: AppEnv["Bindings"], request: Request): boolean {
  if (!env.INTERNAL_IPS) return false;
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return false;
  return env.INTERNAL_IPS.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(ip);
}

export function requestCountry(request: Request): string {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  return cf?.country ?? "unknown";
}

export type MetricsSummaryRow = { event: string; tag: string; last24h: number; last7d: number; last30d: number };
export type MetricsDailyRow = { day: string; event: string; tag: string; hits: number };

export async function fetchMetricsSummary(env: AppEnv["Bindings"]): Promise<MetricsSummaryRow[]> {
  const rows = await runAnalyticsQuery<{ event: string; tag: string; last_24h: number | string; last_7d: number | string; last_30d: number | string }>(
    env,
    `SELECT blob1 AS event, blob2 AS tag,
            countIf(timestamp > NOW() - INTERVAL '1' DAY) AS last_24h,
            countIf(timestamp > NOW() - INTERVAL '7' DAY) AS last_7d,
            countIf(timestamp > NOW() - INTERVAL '30' DAY) AS last_30d
     FROM gsv_deploy_metrics
     GROUP BY event, tag
     ORDER BY event, tag`,
  );
  return rows.map((row) => ({
    event: row.event,
    tag: row.tag,
    last24h: Number(row.last_24h),
    last7d: Number(row.last_7d),
    last30d: Number(row.last_30d),
  }));
}

export async function fetchMetricsDaily(env: AppEnv["Bindings"]): Promise<MetricsDailyRow[]> {
  const rows = await runAnalyticsQuery<{ day: string; event: string; tag: string; hits: number | string }>(
    env,
    `SELECT toDate(timestamp) AS day, blob1 AS event, blob2 AS tag, count() AS hits
     FROM gsv_deploy_metrics
     WHERE timestamp > NOW() - INTERVAL '14' DAY
     GROUP BY day, event, tag
     ORDER BY day DESC`,
  );
  return rows.map((row) => ({ day: row.day, event: row.event, tag: row.tag, hits: Number(row.hits) }));
}

export type MetricsCountryRow = { country: string; hits: number };
export type MetricsHourRow = { hour: number; hits: number };

export async function fetchMetricsByCountry(env: AppEnv["Bindings"]): Promise<MetricsCountryRow[]> {
  const rows = await runAnalyticsQuery<{ country: string; hits: number | string }>(
    env,
    `SELECT blob3 AS country, count() AS hits
     FROM gsv_deploy_metrics
     WHERE timestamp > NOW() - INTERVAL '30' DAY
     GROUP BY country
     ORDER BY hits DESC
     LIMIT 20`,
  );
  return rows.map((row) => ({ country: row.country || "unknown", hits: Number(row.hits) }));
}

export async function fetchMetricsByHour(env: AppEnv["Bindings"]): Promise<MetricsHourRow[]> {
  const rows = await runAnalyticsQuery<{ hour: number | string; hits: number | string }>(
    env,
    `SELECT toHour(timestamp) AS hour, count() AS hits
     FROM gsv_deploy_metrics
     WHERE timestamp > NOW() - INTERVAL '30' DAY
     GROUP BY hour
     ORDER BY hour`,
  );
  return rows.map((row) => ({ hour: Number(row.hour), hits: Number(row.hits) }));
}

export type MetricsRecentDeployRow = {
  jobId: string;
  instance: string;
  account: string;
  release: string;
  status: "running" | "succeeded" | "failed";
  lastAt: string;
};

export async function fetchRecentDeploys(env: AppEnv["Bindings"]): Promise<MetricsRecentDeployRow[]> {
  const rows = await runAnalyticsQuery<{
    job_id: string;
    instance: string;
    account: string;
    release: string;
    succeeded: number | string;
    failed: number | string;
    last_at: string | number;
  }>(
    env,
    `SELECT blob4 AS job_id,
            blob5 AS instance,
            blob6 AS account,
            blob2 AS release,
            countIf(blob1 = 'deploy_success') AS succeeded,
            countIf(blob1 = 'deploy_failed') AS failed,
            max(timestamp) AS last_at
     FROM gsv_deploy_metrics
     WHERE blob1 IN ('deploy_submit', 'deploy_success', 'deploy_failed') AND blob4 != ''
     GROUP BY job_id, instance, account, release
     ORDER BY last_at DESC
     LIMIT 20`,
  );
  return rows.map((row) => ({
    jobId: row.job_id,
    instance: row.instance || "unknown",
    account: row.account || "unknown",
    release: row.release || "unknown",
    status: Number(row.failed) > 0 ? "failed" : Number(row.succeeded) > 0 ? "succeeded" : "running",
    lastAt: String(row.last_at),
  }));
}

async function runAnalyticsQuery<T>(env: AppEnv["Bindings"], sql: string): Promise<T[]> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}` },
    body: sql,
  });
  if (!response.ok) {
    throw new Error(`Analytics Engine query failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { data?: T[] };
  return body.data ?? [];
}

export function requireMetricsAuth(c: Context<AppEnv>): Response | null {
  const credentials = parseBasicAuth(c.req.header("authorization"));
  if (
    credentials &&
    timingSafeEqual(credentials.user, c.env.METRICS_USER) &&
    timingSafeEqual(credentials.pass, c.env.METRICS_PASSWORD)
  ) {
    return null;
  }
  return new Response("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="GSV metrics"' },
  });
}

function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header?.startsWith("Basic ")) return null;

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { user: decoded.slice(0, separator), pass: decoded.slice(separator + 1) };
}
