import {
  appendLogToJob,
  failActiveStepOnJob,
  JOB_TTL_SECONDS,
  updateStepOnJob,
} from "./deploy-job";
import { randomToken, refreshAccessToken, timingSafeEqual } from "./oauth";
import type {
  ActiveDeployCredentials,
  AppEnv,
  DeployAdapterSecrets,
  DeployCredentialRecord,
  DeployJob,
  DeployOptions,
  DeployStep,
  DeployStepId,
  DeployStepStatus,
  PublicDeployJob,
  TokenResponse,
} from "./types";

export { JOB_TTL_SECONDS } from "./deploy-job";

const DEPLOY_TOKEN_REFRESH_LEEWAY_MS = 35 * 60 * 1000;
const JOB_FLUSH_INTERVAL_MS = 1_000;

type FlushOptions = {
  flush?: boolean;
};

export type CreateDeployJobInput = {
  sessionId: string;
  options: DeployOptions;
  token: TokenResponse;
  tokenIssuedAt?: number;
  adapterSecrets?: DeployAdapterSecrets;
};

export type CreatedDeployJob = {
  job: DeployJob;
  viewToken: string;
};

export class DeployJobWriter {
  private dirty = false;
  private lastFlushAt = 0;

  private constructor(
    private readonly env: AppEnv["Bindings"],
    readonly job: DeployJob,
  ) {}

  static async load(env: AppEnv["Bindings"], jobId: string): Promise<DeployJobWriter | null> {
    const job = await getJobForWriter(env, jobId);
    return job ? new DeployJobWriter(env, job) : null;
  }

  async appendLog(level: "info" | "warning" | "error", message: string, options?: FlushOptions): Promise<void> {
    appendLogToJob(this.job, level, message);
    await this.markDirty(options);
  }

  async update(patch: Partial<DeployJob>, options?: FlushOptions): Promise<void> {
    Object.assign(this.job, patch);
    await this.markDirty(options);
  }

  async updateStep(
    stepId: DeployStepId,
    status: DeployStepStatus,
    detail?: string,
    options?: FlushOptions,
  ): Promise<void> {
    updateStepOnJob(this.job, stepId, status, detail);
    await this.markDirty(options);
  }

  async failActiveStep(detail: string, options?: FlushOptions): Promise<void> {
    failActiveStepOnJob(this.job, detail);
    await this.markDirty(options);
  }

  async flush(force = false): Promise<void> {
    if (!this.dirty && !force) return;
    const merged = await deployJobState(this.env, this.job.id).mergeJob(this.job);
    Object.assign(this.job, merged);
    this.dirty = false;
    this.lastFlushAt = Date.now();
  }

  private async markDirty(options?: FlushOptions): Promise<void> {
    this.dirty = true;
    this.job.updatedAt = Date.now();
    if (options?.flush === false) return;
    await this.flushIfDue();
  }

  private async flushIfDue(): Promise<void> {
    if (Date.now() - this.lastFlushAt < JOB_FLUSH_INTERVAL_MS) return;
    await this.flush();
  }
}

export async function createJob(
  env: AppEnv["Bindings"],
  input: CreateDeployJobInput,
): Promise<CreatedDeployJob> {
  const now = Date.now();
  const id = randomToken();
  const viewToken = randomToken();
  const job: DeployJob = {
    id,
    sessionId: input.sessionId,
    viewTokenHash: await hashJobViewToken(id, viewToken),
    status: "queued",
    createdAt: now,
    updatedAt: now,
    options: input.options,
    steps: createDeploySteps(input.options, now),
    logs: [{ at: now, level: "info", message: "Queued deployment." }],
  };
  const credentials = createDeployCredentialRecord(
    input.token,
    input.tokenIssuedAt ?? now,
    input.adapterSecrets,
  );
  await deployJobState(env, id).initialize(job, credentials);
  return { job, viewToken };
}

export async function getJob(env: AppEnv["Bindings"], jobId: string): Promise<DeployJob | null> {
  const current = await deployJobState(env, jobId).getJob();
  if (current) return current;
  return (await readLegacyJob(env, jobId))?.job ?? null;
}

export function appendLog(
  env: AppEnv["Bindings"],
  jobId: string,
  level: "info" | "warning" | "error",
  message: string,
): Promise<void> {
  return deployJobState(env, jobId).appendLog(level, message);
}

export function markJobStartFailure(
  env: AppEnv["Bindings"],
  jobId: string,
  detail: string,
  message: string,
): Promise<void> {
  return deployJobState(env, jobId).failWorkflowStart(detail, message);
}

export async function getDeployCredentials(
  env: AppEnv["Bindings"],
  jobId: string,
): Promise<ActiveDeployCredentials | null> {
  const state = deployJobState(env, jobId);
  let record = await state.getCredentials();
  if (!record || !record.token.access_token) return null;

  if (shouldRefreshDeployToken(record) && record.token.refresh_token) {
    const refreshed = await refreshAccessToken(env, record.token.refresh_token);
    if (!refreshed.access_token) throw new Error("OAuth token refresh returned no access token.");
    record = createDeployCredentialRecord(
      {
        ...record.token,
        ...refreshed,
        refresh_token: refreshed.refresh_token ?? record.token.refresh_token,
      },
      Date.now(),
      record.adapterSecrets,
    );
    await state.setCredentials(record);
  }

  if (isAccessTokenExpired(record)) return null;
  return { ...record.adapterSecrets, accessToken: record.token.access_token };
}

export async function deleteDeployCredentials(env: AppEnv["Bindings"], jobId: string): Promise<void> {
  await deployJobState(env, jobId).deleteCredentials();
  if (await env.SESSIONS.get(legacyDeployTokenKey(jobId))) {
    await env.SESSIONS.delete(legacyDeployTokenKey(jobId));
  }
}

export async function verifyJobViewToken(job: DeployJob, token: string | null): Promise<boolean> {
  if (!token || !job.viewTokenHash) return false;
  const hash = await hashJobViewToken(job.id, token);
  return timingSafeEqual(hash, job.viewTokenHash);
}

export function toPublicDeployJob(job: DeployJob): PublicDeployJob {
  const { sessionId: _sessionId, viewTokenHash: _viewTokenHash, ...publicJob } = job;
  const options = publicJob.options as DeployOptions & DeployAdapterSecrets;
  const {
    discordBotToken: _discordBotToken,
    telegramBotToken: _telegramBotToken,
    ...publicOptions
  } = options;
  return { ...publicJob, options: publicOptions };
}

function deployJobState(env: AppEnv["Bindings"], jobId: string) {
  return env.DEPLOY_JOBS.getByName(jobId);
}

async function getJobForWriter(env: AppEnv["Bindings"], jobId: string): Promise<DeployJob | null> {
  const state = deployJobState(env, jobId);
  const current = await state.getJob();
  if (current) return current;

  const legacy = await readLegacyJob(env, jobId);
  if (!legacy) return null;
  const credentials = await readLegacyDeployCredentials(env, jobId, legacy.adapterSecrets);
  try {
    await state.initialize(legacy.job, credentials);
  } catch (error) {
    const concurrentlyMigrated = await state.getJob();
    if (concurrentlyMigrated) return concurrentlyMigrated;
    throw error;
  }
  return legacy.job;
}

async function readLegacyJob(
  env: AppEnv["Bindings"],
  jobId: string,
): Promise<{ job: DeployJob; adapterSecrets: DeployAdapterSecrets } | null> {
  const raw = await env.SESSIONS.get(legacyJobKey(jobId));
  if (!raw) return null;

  try {
    const job = JSON.parse(raw) as DeployJob;
    if (!job || job.id !== jobId || !isRecord(job.options)) return null;
    const options = job.options as DeployOptions & DeployAdapterSecrets;
    const { discordBotToken, telegramBotToken, ...safeOptions } = options;
    job.options = safeOptions;
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      job.steps = createDeploySteps(job.options, job.createdAt);
    }
    return {
      job,
      adapterSecrets: { discordBotToken, telegramBotToken },
    };
  } catch {
    return null;
  }
}

async function readLegacyDeployCredentials(
  env: AppEnv["Bindings"],
  jobId: string,
  adapterSecrets: DeployAdapterSecrets,
): Promise<DeployCredentialRecord | null> {
  const raw = await env.SESSIONS.get(legacyDeployTokenKey(jobId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && isRecord(parsed.token) && typeof parsed.token.access_token === "string") {
      return {
        token: parsed.token as TokenResponse,
        accessTokenExpiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
        adapterSecrets,
      };
    }
    if (isRecord(parsed) && typeof parsed.access_token === "string") {
      return createDeployCredentialRecord(parsed as TokenResponse, Date.now(), adapterSecrets);
    }
  } catch {
    // The original deployer stored only the access-token string.
  }

  return {
    token: { access_token: raw, token_type: "Bearer" },
    adapterSecrets,
  };
}

function legacyJobKey(jobId: string): string {
  return `deploy-job:${jobId}`;
}

function legacyDeployTokenKey(jobId: string): string {
  return `deploy-token:${jobId}`;
}

function createDeployCredentialRecord(
  token: TokenResponse,
  issuedAt: number,
  adapterSecrets: DeployAdapterSecrets = {},
): DeployCredentialRecord {
  const accessTokenExpiresAt =
    typeof token.expires_in === "number" && token.expires_in > 0
      ? issuedAt + token.expires_in * 1000
      : undefined;
  return { token, accessTokenExpiresAt, adapterSecrets };
}

function shouldRefreshDeployToken(record: DeployCredentialRecord): boolean {
  return (
    typeof record.accessTokenExpiresAt === "number" &&
    Date.now() + DEPLOY_TOKEN_REFRESH_LEEWAY_MS >= record.accessTokenExpiresAt
  );
}

function isAccessTokenExpired(record: DeployCredentialRecord): boolean {
  return typeof record.accessTokenExpiresAt === "number" && Date.now() >= record.accessTokenExpiresAt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function hashJobViewToken(jobId: string, token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${jobId}:${token}`));
  return hex(bytes);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createDeploySteps(options: DeployOptions, now: number): DeployStep[] {
  const account = options.accountName?.trim() || options.accountId;
  const steps: DeployStep[] = [
    {
      id: "authorize",
      title: "Authorize Cloudflare",
      description: "Confirm access to the selected Cloudflare account.",
      status: "complete",
      detail: `Authorized ${account}.`,
      updatedAt: now,
    },
    {
      id: "release",
      title: "Choose GSV release",
      description: "Find the requested GSV release and deployment bundles.",
      status: "pending",
    },
    {
      id: "prepare",
      title: "Prepare components",
      description: "Download and verify the selected GSV components.",
      status: "pending",
    },
    {
      id: "storage",
      title: "Create storage",
      description: "Set up the storage resources this GSV instance needs.",
      status: "pending",
    },
    {
      id: "workers",
      title: "Deploy Workers",
      description: "Upload GSV Workers and static assets to Cloudflare.",
      status: "pending",
    },
    {
      id: "bindings",
      title: "Connect services",
      description: "Wire Workers together with service bindings.",
      status: "pending",
    },
  ];

  if (options.components.some((component) => component.startsWith("channel-"))) {
    steps.push({
      id: "adapters",
      title: "Configure channels",
      description: "Apply channel settings and optional bot tokens.",
      status: "pending",
    });
  }

  steps.push({
    id: "finish",
    title: "Finish setup",
    description: "Confirm the deployment result and prepare the setup link.",
    status: "pending",
  });

  return steps;
}
