import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { fetchDeployTotals, fetchInstallList } from "../src/history";
import type { AppEnv } from "../src/types";

const bindings = env as unknown as AppEnv["Bindings"];

// wrangler.jsonc pins INTERNAL_ACCOUNT_IDS to the founders' own account so its
// deploys never inflate the public numbers.
const INTERNAL_ACCOUNT = "f7c938a773193df3a4ac230b24bc8259";

function isoDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function insertDeploy(
  day: string,
  accountId: string,
  accountLabel: string,
  instance: string,
  successes: number,
  failures: number,
): Promise<void> {
  await bindings.METRICS_DB.prepare(
    `INSERT OR REPLACE INTO daily_deploys (day, account_id, account_label, instance, release, successes, failures)
     VALUES (?, ?, ?, ?, 'latest', ?, ?)`,
  )
    .bind(day, accountId, accountLabel, instance, successes, failures)
    .run();
}

describe("fetchDeployTotals", () => {
  beforeEach(async () => {
    // fetchDeployTotals creates the schema on first call; run it once so the table
    // exists, then start each test from a clean slate.
    await fetchDeployTotals(bindings);
    await bindings.METRICS_DB.prepare(`DELETE FROM daily_deploys`).run();
  });

  it("counts distinct installs and excludes the internal account", async () => {
    const today = isoDay(0);
    const old = isoDay(40);

    // Same install (account + instance) deployed twice today and once long ago:
    // one install, three successful deploys.
    await insertDeploy(today, "acc-public-1", "", "gsv", 2, 0);
    await insertDeploy(old, "acc-public-1", "", "gsv", 1, 0);
    // A different public install.
    await insertDeploy(today, "acc-public-2", "", "gsv-work", 1, 0);
    // Internal account — must be excluded entirely.
    await insertDeploy(today, INTERNAL_ACCOUNT, "humans & machines", "gsv", 5, 1);

    const totals = await fetchDeployTotals(bindings);

    expect(totals.accountsAllTime).toBe(2); // acc-public-1, acc-public-2
    expect(totals.installsAllTime).toBe(2);
    expect(totals.installs30d).toBe(2);
    expect(totals.installs7d).toBe(2);
    expect(totals.deploysAllTime).toBe(4); // 2 + 1 + 1, internal's 5 excluded
    expect(totals.deploys30d).toBe(3); // 40-day-old deploy falls outside the window
    expect(totals.deploys7d).toBe(3);
    expect(totals.failuresAllTime).toBe(0); // only the internal row had a failure
  });

  it("counts one account with several installs as one account but many installs", async () => {
    const today = isoDay(0);
    await insertDeploy(today, "acc-multi", "", "gsv", 1, 0);
    await insertDeploy(today, "acc-multi", "", "gsv-work", 1, 0);
    await insertDeploy(today, "acc-multi", "", "gsv-personal", 3, 0); // redeploys don't inflate installs

    const totals = await fetchDeployTotals(bindings);

    expect(totals.accountsAllTime).toBe(1);
    expect(totals.installsAllTime).toBe(3);
    expect(totals.deploysAllTime).toBe(5); // 1 + 1 + 3
  });

  it("does not count installs that only ever failed", async () => {
    const today = isoDay(0);
    await insertDeploy(today, "acc-fail-only", "", "gsv", 0, 3);

    const totals = await fetchDeployTotals(bindings);

    expect(totals.installsAllTime).toBe(0);
    expect(totals.deploysAllTime).toBe(0);
    expect(totals.failuresAllTime).toBe(3);
  });

  it("drops pre-instrumentation deploys with no attributable account", async () => {
    const today = isoDay(0);
    // Both account id and label blank — e.g. internal test deploys made before the
    // account was recorded. Cannot be attributed, so must not appear in any total.
    await insertDeploy(today, "", "", "", 4, 1);
    await insertDeploy(today, "acc-real", "", "gsv", 2, 0);

    const totals = await fetchDeployTotals(bindings);

    expect(totals.accountsAllTime).toBe(1);
    expect(totals.installsAllTime).toBe(1);
    expect(totals.deploysAllTime).toBe(2); // the blank-account 4 is excluded
    expect(totals.failuresAllTime).toBe(0);
  });
});

async function insertDeployRelease(day: string, accountLabel: string, instance: string, release: string): Promise<void> {
  await bindings.METRICS_DB.prepare(
    `INSERT OR REPLACE INTO daily_deploys (day, account_id, account_label, instance, release, successes, failures)
     VALUES (?, '', ?, ?, ?, 1, 0)`,
  )
    .bind(day, accountLabel, instance, release)
    .run();
}

describe("fetchInstallList", () => {
  beforeEach(async () => {
    await fetchInstallList(bindings);
    await bindings.METRICS_DB.prepare(`DELETE FROM daily_deploys`).run();
  });

  it("lists one row per install with its latest release and date range", async () => {
    // Same install updated across three days with a newer release each time.
    await insertDeployRelease(isoDay(10), "Acme", "gsv", "v0.8.0");
    await insertDeployRelease(isoDay(5), "Acme", "gsv", "v0.9.0");
    await insertDeployRelease(isoDay(1), "Acme", "gsv", "latest");
    // A second, separate install with more recent activity.
    await insertDeployRelease(isoDay(0), "Beta Co", "gsv-work", "latest");
    // Internal account — excluded from the list.
    await insertDeployRelease(isoDay(0), INTERNAL_ACCOUNT, "gsv", "latest");

    const installs = await fetchInstallList(bindings);

    expect(installs).toHaveLength(2);
    // Sorted by most recent activity first.
    expect(installs[0]).toMatchObject({ account: "Beta Co", instance: "gsv-work" });

    const acme = installs.find((row) => row.account === "Acme");
    expect(acme).toBeDefined();
    expect(acme!.release).toBe("latest"); // release from the most recent deploy
    expect(acme!.firstDay).toBe(isoDay(10));
    expect(acme!.lastDay).toBe(isoDay(1));
    expect(acme!.deploys).toBe(3);
  });

  it("omits blank-account rows from the list", async () => {
    await insertDeployRelease(isoDay(0), "", "", "latest"); // no account, no instance
    await insertDeployRelease(isoDay(0), "Real Co", "gsv", "latest");

    const installs = await fetchInstallList(bindings);

    expect(installs).toHaveLength(1);
    expect(installs[0].account).toBe("Real Co");
    expect(installs[0].internal).toBe(false);
  });

  it("includes internal and blank-account rows (flagged) when asked", async () => {
    await insertDeployRelease(isoDay(0), "", "", "latest"); // unattributable
    await insertDeployRelease(isoDay(1), INTERNAL_ACCOUNT, "gsv", "latest"); // internal by id/label
    await insertDeployRelease(isoDay(2), "Real Co", "gsv", "latest");

    const publicOnly = await fetchInstallList(bindings, false);
    expect(publicOnly).toHaveLength(1);

    const all = await fetchInstallList(bindings, true);
    expect(all).toHaveLength(3);
    expect(all.filter((row) => row.internal)).toHaveLength(2);
    expect(all.find((row) => row.account === "Real Co")!.internal).toBe(false);
  });
});
