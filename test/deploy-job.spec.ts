import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeployJobState } from "../src/deploy-job";
import { DeployJobWriter, getDeployCredentials, toPublicDeployJob } from "../src/jobs";
import type { AppEnv, DeployCredentialRecord, DeployJob } from "../src/types";

const bindings = env as unknown as AppEnv["Bindings"];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DeployJobState", () => {
  it("stores job state and deployment credentials separately", async () => {
    const stub = bindings.DEPLOY_JOBS.getByName("separate-state");
    const job = sampleJob("separate-state");
    const credentials = sampleCredentials();

    await stub.initialize(job, credentials);

    expect(await stub.getJob()).toEqual(job);
    expect(await stub.getCredentials()).toEqual(credentials);
    expect(JSON.stringify(await stub.getJob())).not.toContain("discord-secret");
  });

  it("merges a stale workflow writer without dropping concurrent logs", async () => {
    const stub = bindings.DEPLOY_JOBS.getByName("concurrent-merge");
    const job = sampleJob("concurrent-merge");
    await stub.initialize(job, sampleCredentials());

    const pending = await stub.getJob();
    expect(pending).not.toBeNull();
    await stub.appendLog("info", "Started deployment workflow workflow-id.");

    pending!.status = "running";
    pending!.logs.push({ at: Date.now() + 1, level: "info", message: "Preparing deployment." });
    const releaseStep = pending!.steps.find((step) => step.id === "release");
    expect(releaseStep).toBeDefined();
    releaseStep!.status = "running";
    releaseStep!.updatedAt = Date.now() + 1;

    const merged = await stub.mergeJob(pending!);

    expect(merged.status).toBe("running");
    expect(merged.logs.map((log) => log.message)).toEqual([
      "Queued deployment.",
      "Started deployment workflow workflow-id.",
      "Preparing deployment.",
    ]);
    expect(merged.steps.find((step) => step.id === "release")?.status).toBe("running");
  });

  it("atomically records workflow start failure and removes credentials", async () => {
    const stub = bindings.DEPLOY_JOBS.getByName("start-failure");
    await stub.initialize(sampleJob("start-failure"), sampleCredentials());

    await stub.failWorkflowStart("Retry in a moment.", "Workflow service unavailable");

    const job = await stub.getJob();
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("Workflow service unavailable");
    expect(job?.steps.find((step) => step.id === "release")).toMatchObject({
      status: "failed",
      detail: "Retry in a moment.",
    });
    expect(await stub.getCredentials()).toBeNull();
  });

  it("deletes expired job and credential state when its alarm runs", async () => {
    const stub = bindings.DEPLOY_JOBS.getByName("expiry-alarm");
    await stub.initialize(sampleJob("expiry-alarm"), sampleCredentials());

    await runInDurableObject<DeployJobState, void>(stub, async (_instance, state) => {
      for (const [key, stored] of state.storage.kv.list<{ value: unknown; expiresAt: number }>()) {
        state.storage.kv.put(key, { ...stored, expiresAt: 0 });
      }
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getJob()).toBeNull();
    expect(await stub.getCredentials()).toBeNull();
  });

  it("imports an in-flight legacy KV job before a workflow writes it", async () => {
    const job = sampleJob("legacy-job");
    Object.assign(job.options, { discordBotToken: "legacy-discord-secret" });
    await bindings.SESSIONS.put(`deploy-job:${job.id}`, JSON.stringify(job));
    await bindings.SESSIONS.put(`deploy-token:${job.id}`, "legacy-access-token");

    const writer = await DeployJobWriter.load(bindings, job.id);
    const stub = bindings.DEPLOY_JOBS.getByName(job.id);

    expect(writer?.job.options).not.toHaveProperty("discordBotToken");
    expect(await stub.getJob()).not.toBeNull();
    expect(await stub.getCredentials()).toMatchObject({
      token: { access_token: "legacy-access-token" },
      adapterSecrets: { discordBotToken: "legacy-discord-secret" },
    });
  });

  it("refreshes expiring OAuth credentials without dropping adapter secrets", async () => {
    const stub = bindings.DEPLOY_JOBS.getByName("token-refresh");
    const credentials = sampleCredentials();
    credentials.accessTokenExpiresAt = Date.now() + 60_000;
    await stub.initialize(sampleJob("token-refresh"), credentials);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      access_token: "refreshed-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 7200,
      token_type: "Bearer",
    }));

    const active = await getDeployCredentials(bindings, "token-refresh");

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://dash.cloudflare.com/oauth2/token");
    expect(active).toEqual({
      accessToken: "refreshed-access-token",
      discordBotToken: "discord-secret",
    });
    expect(await stub.getCredentials()).toMatchObject({
      token: {
        access_token: "refreshed-access-token",
        refresh_token: "rotated-refresh-token",
      },
      adapterSecrets: { discordBotToken: "discord-secret" },
    });
  });
});

describe("toPublicDeployJob", () => {
  it("removes internal identifiers and legacy adapter secrets", () => {
    const job = sampleJob("public-job");
    Object.assign(job.options, {
      discordBotToken: "legacy-discord-secret",
      telegramBotToken: "legacy-telegram-secret",
    });

    const publicJob = toPublicDeployJob(job);

    expect(publicJob).not.toHaveProperty("sessionId");
    expect(publicJob).not.toHaveProperty("viewTokenHash");
    expect(publicJob.options).not.toHaveProperty("discordBotToken");
    expect(publicJob.options).not.toHaveProperty("telegramBotToken");
  });
});

function sampleJob(id: string): DeployJob {
  const now = Date.now();
  return {
    id,
    sessionId: "session-id",
    viewTokenHash: "view-token-hash",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    options: {
      accountId: "account-id",
      accountName: "Test account",
      instance: "gsv",
      version: "v1.2.3",
      components: ["gateway"],
    },
    steps: [
      {
        id: "authorize",
        title: "Authorize Cloudflare",
        description: "Authorize the account.",
        status: "complete",
        updatedAt: now,
      },
      {
        id: "release",
        title: "Choose GSV release",
        description: "Resolve the release.",
        status: "pending",
      },
    ],
    logs: [{ at: now, level: "info", message: "Queued deployment." }],
  };
}

function sampleCredentials(): DeployCredentialRecord {
  return {
    token: {
      access_token: "oauth-access-token",
      refresh_token: "oauth-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    },
    accessTokenExpiresAt: Date.now() + 3_600_000,
    adapterSecrets: { discordBotToken: "discord-secret" },
  };
}
