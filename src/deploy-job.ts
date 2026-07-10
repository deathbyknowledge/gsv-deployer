import { DurableObject } from "cloudflare:workers";

import type {
  AppEnv,
  DeployCredentialRecord,
  DeployJob,
  DeployStep,
  DeployStepId,
  DeployStepStatus,
} from "./types";

export const JOB_TTL_SECONDS = 24 * 60 * 60;
export const DEPLOY_CREDENTIAL_TTL_SECONDS = 12 * 60 * 60;

const JOB_STATE_KEY = "job";
const CREDENTIAL_STATE_KEY = "credentials";

type ExpiringState<T> = {
  value: T;
  expiresAt: number;
};

type ReadState<T> = {
  value: T | null;
  expired: boolean;
};

export class DeployJobState extends DurableObject<AppEnv["Bindings"]> {
  async initialize(job: DeployJob, credentials: DeployCredentialRecord | null): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const existing = this.readLiveState<DeployJob>(JOB_STATE_KEY, now);
      if (existing.value) throw new Error(`Deployment job ${job.id} already exists.`);

      this.writeState(JOB_STATE_KEY, job, now + JOB_TTL_SECONDS * 1000);
      this.ctx.storage.kv.delete(CREDENTIAL_STATE_KEY);
      if (credentials) {
        this.writeState(
          CREDENTIAL_STATE_KEY,
          credentials,
          now + DEPLOY_CREDENTIAL_TTL_SECONDS * 1000,
        );
      }
    });
    await this.scheduleExpiration();
  }

  async getJob(): Promise<DeployJob | null> {
    const state = this.readLiveState<DeployJob>(JOB_STATE_KEY);
    if (state.expired) await this.scheduleExpiration();
    return state.value;
  }

  async mergeJob(pending: DeployJob): Promise<DeployJob> {
    const now = Date.now();
    let merged: DeployJob | null = null;
    this.ctx.storage.transactionSync(() => {
      const current = this.readLiveState<DeployJob>(JOB_STATE_KEY, now).value;
      if (!current) throw new Error(`Deployment job ${pending.id} was not found.`);

      merged = mergeJobForSave(current, pending);
      merged.updatedAt = now;
      this.writeState(JOB_STATE_KEY, merged, now + JOB_TTL_SECONDS * 1000);
    });
    await this.scheduleExpiration();
    if (!merged) throw new Error(`Deployment job ${pending.id} was not found.`);
    return merged;
  }

  async appendLog(level: "info" | "warning" | "error", message: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const job = this.requireJob(now);
      appendLogToJob(job, level, message, now);
      job.updatedAt = now;
      this.writeState(JOB_STATE_KEY, job, now + JOB_TTL_SECONDS * 1000);
    });
    await this.scheduleExpiration();
  }

  async failWorkflowStart(detail: string, message: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const job = this.requireJob(now);
      failActiveStepOnJob(job, detail, now);
      appendLogToJob(job, "error", `Failed to start deployment workflow: ${message}`, now);
      job.status = "failed";
      job.error = message;
      job.updatedAt = now;
      this.writeState(JOB_STATE_KEY, job, now + JOB_TTL_SECONDS * 1000);
      this.ctx.storage.kv.delete(CREDENTIAL_STATE_KEY);
    });
    await this.scheduleExpiration();
  }

  async getCredentials(): Promise<DeployCredentialRecord | null> {
    const state = this.readLiveState<DeployCredentialRecord>(CREDENTIAL_STATE_KEY);
    if (state.expired) await this.scheduleExpiration();
    return state.value;
  }

  async setCredentials(credentials: DeployCredentialRecord): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.requireJob(now);
      this.writeState(
        CREDENTIAL_STATE_KEY,
        credentials,
        now + DEPLOY_CREDENTIAL_TTL_SECONDS * 1000,
      );
    });
    await this.scheduleExpiration();
  }

  async deleteCredentials(): Promise<void> {
    this.ctx.storage.kv.delete(CREDENTIAL_STATE_KEY);
    await this.scheduleExpiration();
  }

  async alarm(): Promise<void> {
    this.pruneExpiredState();
    await this.scheduleExpiration();
  }

  private requireJob(now: number): DeployJob {
    const job = this.readLiveState<DeployJob>(JOB_STATE_KEY, now).value;
    if (!job) throw new Error("Deployment job was not found.");
    return job;
  }

  private readLiveState<T>(key: string, now = Date.now()): ReadState<T> {
    const stored = this.ctx.storage.kv.get<ExpiringState<T>>(key);
    if (!isExpiringState(stored)) {
      if (stored !== undefined) this.ctx.storage.kv.delete(key);
      return { value: null, expired: stored !== undefined };
    }
    if (stored.expiresAt <= now) {
      this.ctx.storage.kv.delete(key);
      return { value: null, expired: true };
    }
    return { value: stored.value, expired: false };
  }

  private writeState<T>(key: string, value: T, expiresAt: number): void {
    this.ctx.storage.kv.put<ExpiringState<T>>(key, { value, expiresAt });
  }

  private pruneExpiredState(now = Date.now()): void {
    this.readLiveState(JOB_STATE_KEY, now);
    this.readLiveState(CREDENTIAL_STATE_KEY, now);
  }

  private async scheduleExpiration(): Promise<void> {
    this.pruneExpiredState();
    const expirations = [JOB_STATE_KEY, CREDENTIAL_STATE_KEY]
      .map((key) => this.ctx.storage.kv.get<ExpiringState<unknown>>(key))
      .filter(isExpiringState)
      .map((state) => state.expiresAt);

    if (expirations.length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const nextExpiration = Math.min(...expirations);
    if (await this.ctx.storage.getAlarm() !== nextExpiration) {
      await this.ctx.storage.setAlarm(nextExpiration);
    }
  }
}

export function appendLogToJob(
  job: DeployJob,
  level: "info" | "warning" | "error",
  message: string,
  now = Date.now(),
): void {
  job.logs.push({ at: now, level, message });
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
}

export function updateStepOnJob(
  job: DeployJob,
  stepId: DeployStepId,
  status: DeployStepStatus,
  detail?: string,
  now = Date.now(),
): void {
  const step = job.steps.find((item) => item.id === stepId);
  if (!step) return;
  step.status = status;
  step.updatedAt = now;
  if (detail !== undefined) step.detail = detail;
}

export function failActiveStepOnJob(job: DeployJob, detail: string, now = Date.now()): void {
  const running = job.steps.find((step) => step.status === "running");
  const target = running ?? job.steps.find((step) => step.status === "pending") ?? job.steps.at(-1);
  if (!target) return;
  target.status = "failed";
  target.detail = detail;
  target.updatedAt = now;
}

function mergeJobForSave(latest: DeployJob, pending: DeployJob): DeployJob {
  return {
    ...latest,
    ...pending,
    steps: mergeSteps(latest.steps, pending.steps),
    logs: mergeLogs(latest.logs, pending.logs),
  };
}

function mergeSteps(latest: DeployStep[], pending: DeployStep[]): DeployStep[] {
  const latestById = new Map(latest.map((step) => [step.id, step]));
  const merged = pending.map((step) => {
    const current = latestById.get(step.id);
    if (!current) return step;
    return (current.updatedAt ?? 0) > (step.updatedAt ?? 0) ? current : step;
  });
  const seen = new Set(merged.map((step) => step.id));
  for (const step of latest) {
    if (!seen.has(step.id)) merged.push(step);
  }
  return merged;
}

function mergeLogs(latest: DeployJob["logs"], pending: DeployJob["logs"]): DeployJob["logs"] {
  const seen = new Set<string>();
  const merged: DeployJob["logs"] = [];
  for (const log of [...latest, ...pending].sort((a, b) => a.at - b.at)) {
    const key = `${log.at}:${log.level}:${log.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(log);
  }
  if (merged.length > 300) merged.splice(0, merged.length - 300);
  return merged;
}

function isExpiringState(value: unknown): value is ExpiringState<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt)
  );
}
