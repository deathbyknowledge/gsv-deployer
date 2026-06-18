import type { AppEnv, DeployJob, DeployOptions, DeployStep, DeployStepId, DeployStepStatus } from "./types";
import { randomToken } from "./oauth";

const JOB_TTL_SECONDS = 24 * 60 * 60;
const DEPLOY_TOKEN_TTL_SECONDS = 2 * 60 * 60;

export async function createJob(
  env: AppEnv["Bindings"],
  sessionId: string,
  options: DeployOptions,
): Promise<DeployJob> {
  const now = Date.now();
  const job: DeployJob = {
    id: randomToken(),
    sessionId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    options,
    steps: createDeploySteps(options, now),
    logs: [{ at: now, level: "info", message: "Queued deployment." }],
  };
  await saveJob(env, job);
  return job;
}

export async function getJob(
  env: AppEnv["Bindings"],
  jobId: string,
): Promise<DeployJob | null> {
  const raw = await env.SESSIONS.get(jobKey(jobId));
  if (!raw) return null;
  try {
    return normalizeJob(JSON.parse(raw) as DeployJob);
  } catch {
    return null;
  }
}

export async function saveJob(env: AppEnv["Bindings"], job: DeployJob): Promise<void> {
  job.updatedAt = Date.now();
  await env.SESSIONS.put(jobKey(job.id), JSON.stringify(job), {
    expirationTtl: JOB_TTL_SECONDS,
  });
}

export async function appendLog(
  env: AppEnv["Bindings"],
  jobId: string,
  level: "info" | "warning" | "error",
  message: string,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) return;
  job.logs.push({ at: Date.now(), level, message });
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  await saveJob(env, job);
}

export async function updateJob(
  env: AppEnv["Bindings"],
  jobId: string,
  patch: Partial<DeployJob>,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) return;
  Object.assign(job, patch);
  await saveJob(env, job);
}

export async function updateJobStep(
  env: AppEnv["Bindings"],
  jobId: string,
  stepId: DeployStepId,
  status: DeployStepStatus,
  detail?: string,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) return;
  const step = job.steps.find((item) => item.id === stepId);
  if (!step) return;
  step.status = status;
  step.updatedAt = Date.now();
  if (detail !== undefined) step.detail = detail;
  await saveJob(env, job);
}

export async function failActiveJobStep(
  env: AppEnv["Bindings"],
  jobId: string,
  detail: string,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) return;
  const running = job.steps.find((step) => step.status === "running");
  const target = running ?? job.steps.find((step) => step.status === "pending") ?? job.steps.at(-1);
  if (!target) return;
  target.status = "failed";
  target.detail = detail;
  target.updatedAt = Date.now();
  await saveJob(env, job);
}

export async function storeDeployToken(
  env: AppEnv["Bindings"],
  jobId: string,
  accessToken: string,
): Promise<void> {
  await env.SESSIONS.put(deployTokenKey(jobId), accessToken, {
    expirationTtl: DEPLOY_TOKEN_TTL_SECONDS,
  });
}

export async function getDeployToken(
  env: AppEnv["Bindings"],
  jobId: string,
): Promise<string | null> {
  return env.SESSIONS.get(deployTokenKey(jobId));
}

export async function deleteDeployToken(
  env: AppEnv["Bindings"],
  jobId: string,
): Promise<void> {
  await env.SESSIONS.delete(deployTokenKey(jobId));
}

function jobKey(jobId: string): string {
  return `deploy-job:${jobId}`;
}

function deployTokenKey(jobId: string): string {
  return `deploy-token:${jobId}`;
}

function normalizeJob(job: DeployJob): DeployJob {
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    job.steps = createDeploySteps(job.options, job.createdAt);
  }
  return job;
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
