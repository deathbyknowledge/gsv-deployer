import type { AppEnv } from "./types";
import { runAnalyticsQuery } from "./metrics";
import type { MetricsDailyRow } from "./metrics";

// Analytics Engine only retains ~90 days. To keep history beyond that, a nightly
// scheduled handler rolls the raw events up into per-day aggregates stored in D1,
// which never expire. Two tables:
//   daily_events  — funnel counts per (day, event, tag), mirroring the AE daily query
//   daily_deploys — deploy outcomes per (day, account, instance, release)
// Rollups are idempotent (INSERT OR REPLACE), so re-running a day just refreshes it.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS daily_events (
    day TEXT NOT NULL,
    event TEXT NOT NULL,
    tag TEXT NOT NULL DEFAULT '',
    hits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, event, tag)
  )`,
  `CREATE TABLE IF NOT EXISTS daily_deploys (
    day TEXT NOT NULL,
    account_id TEXT NOT NULL DEFAULT '',
    account_label TEXT NOT NULL DEFAULT '',
    instance TEXT NOT NULL DEFAULT '',
    release TEXT NOT NULL DEFAULT '',
    successes INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, account_id, account_label, instance, release)
  )`,
];

let schemaReady: Promise<void> | null = null;

async function ensureSchema(env: AppEnv["Bindings"]): Promise<void> {
  if (!schemaReady) {
    schemaReady = env.METRICS_DB.batch(SCHEMA.map((sql) => env.METRICS_DB.prepare(sql))).then(() => undefined);
  }
  try {
    await schemaReady;
  } catch (error) {
    // Reset so a transient failure doesn't permanently poison every later call.
    schemaReady = null;
    throw error;
  }
}

export function internalAccountIds(env: AppEnv["Bindings"]): Set<string> {
  return new Set(
    (env.INTERNAL_ACCOUNT_IDS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export type RollupResult = { days: number; eventRows: number; deployRows: number };

// Rolls the last `days` days of Analytics Engine data into the D1 aggregate tables.
// Called nightly for a small trailing window (to absorb late-arriving events) and
// once with a wide window to backfill everything AE still holds.
export async function rollupHistory(env: AppEnv["Bindings"], days: number): Promise<RollupResult> {
  await ensureSchema(env);
  const window = Math.max(1, Math.min(Math.floor(days), 90));

  const eventRows = await runAnalyticsQuery<{ day: string; event: string; tag: string; hits: number | string }>(
    env,
    `SELECT toDate(timestamp) AS day, blob1 AS event, blob2 AS tag, count() AS hits
     FROM gsv_deploy_metrics
     WHERE timestamp > NOW() - INTERVAL '${window}' DAY
     GROUP BY day, event, tag`,
  );

  const deployRows = await runAnalyticsQuery<{
    day: string;
    account_label: string;
    account_id: string;
    instance: string;
    release: string;
    successes: number | string;
    failures: number | string;
  }>(
    env,
    `SELECT toDate(timestamp) AS day,
            blob6 AS account_label,
            blob7 AS account_id,
            blob5 AS instance,
            blob2 AS release,
            countIf(blob1 = 'deploy_success') AS successes,
            countIf(blob1 = 'deploy_failed') AS failures
     FROM gsv_deploy_metrics
     WHERE blob1 IN ('deploy_success', 'deploy_failed') AND timestamp > NOW() - INTERVAL '${window}' DAY
     GROUP BY day, account_label, account_id, instance, release`,
  );

  const statements = [
    ...eventRows.map((row) =>
      env.METRICS_DB.prepare(`INSERT OR REPLACE INTO daily_events (day, event, tag, hits) VALUES (?, ?, ?, ?)`).bind(
        row.day,
        row.event ?? "",
        row.tag ?? "",
        Number(row.hits),
      ),
    ),
    ...deployRows.map((row) =>
      env.METRICS_DB.prepare(
        `INSERT OR REPLACE INTO daily_deploys (day, account_id, account_label, instance, release, successes, failures)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.day,
        row.account_id ?? "",
        row.account_label ?? "",
        row.instance ?? "",
        row.release ?? "",
        Number(row.successes),
        Number(row.failures),
      ),
    ),
  ];

  // D1 caps statements per batch; chunk to stay comfortably under it.
  for (let i = 0; i < statements.length; i += 100) {
    await env.METRICS_DB.batch(statements.slice(i, i + 100));
  }

  return { days: window, eventRows: eventRows.length, deployRows: deployRows.length };
}

export type DeployTotals = {
  accountsAllTime: number;
  accounts30d: number;
  accounts7d: number;
  installsAllTime: number;
  installs30d: number;
  installs7d: number;
  deploysAllTime: number;
  deploys30d: number;
  deploys7d: number;
  failuresAllTime: number;
  firstDay: string | null;
};

type DeployHistoryRow = {
  day: string;
  account_id: string;
  account_label: string;
  instance: string;
  successes: number;
  failures: number;
};

// Old rows may lack account_id, so fall back to the human-readable label to key
// an account. An "install" is one such account paired with an install name.
function accountKey(row: DeployHistoryRow): string {
  return row.account_id || row.account_label;
}

function installKey(row: DeployHistoryRow): string {
  return `${accountKey(row)}::${row.instance}`;
}

export async function fetchDeployTotals(env: AppEnv["Bindings"]): Promise<DeployTotals> {
  await ensureSchema(env);
  const internal = internalAccountIds(env);
  const { results } = await env.METRICS_DB.prepare(
    `SELECT day, account_id, account_label, instance, successes, failures FROM daily_deploys`,
  ).all<DeployHistoryRow>();

  const rows = (results ?? []).filter(
    (row) => !internal.has(row.account_id) && !internal.has(row.account_label),
  );

  const cutoff = (days: number): string => isoDay(daysAgo(days));
  const cut30 = cutoff(30);
  const cut7 = cutoff(7);

  const accountsAll = new Set<string>();
  const accounts30 = new Set<string>();
  const accounts7 = new Set<string>();
  const installsAll = new Set<string>();
  const installs30 = new Set<string>();
  const installs7 = new Set<string>();
  let deploysAllTime = 0;
  let deploys30d = 0;
  let deploys7d = 0;
  let failuresAllTime = 0;
  let firstDay: string | null = null;

  for (const row of rows) {
    const successes = Number(row.successes) || 0;
    const failures = Number(row.failures) || 0;
    deploysAllTime += successes;
    failuresAllTime += failures;
    if (row.day >= cut30) deploys30d += successes;
    if (row.day >= cut7) deploys7d += successes;
    if (firstDay === null || row.day < firstDay) firstDay = row.day;
    if (successes > 0) {
      const account = accountKey(row);
      const install = installKey(row);
      accountsAll.add(account);
      installsAll.add(install);
      if (row.day >= cut30) {
        accounts30.add(account);
        installs30.add(install);
      }
      if (row.day >= cut7) {
        accounts7.add(account);
        installs7.add(install);
      }
    }
  }

  return {
    accountsAllTime: accountsAll.size,
    accounts30d: accounts30.size,
    accounts7d: accounts7.size,
    installsAllTime: installsAll.size,
    installs30d: installs30.size,
    installs7d: installs7.size,
    deploysAllTime,
    deploys30d,
    deploys7d,
    failuresAllTime,
    firstDay,
  };
}

// Returns rolled-up funnel counts in the same shape as the AE daily query so the
// existing pivot/render code can consume either source.
export async function fetchDailyHistory(env: AppEnv["Bindings"], maxDays: number): Promise<MetricsDailyRow[]> {
  await ensureSchema(env);
  const cutoff = isoDay(daysAgo(maxDays));
  const { results } = await env.METRICS_DB.prepare(
    `SELECT day, event, tag, hits FROM daily_events WHERE day >= ? ORDER BY day DESC`,
  )
    .bind(cutoff)
    .all<{ day: string; event: string; tag: string; hits: number }>();
  return (results ?? []).map((row) => ({
    day: row.day,
    event: row.event,
    tag: row.tag,
    hits: Number(row.hits),
  }));
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
