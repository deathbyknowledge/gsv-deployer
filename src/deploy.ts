import { blake3 } from "@noble/hashes/blake3.js";
import type { WorkflowStep } from "cloudflare:workers";
import { parse as parseJsonc } from "jsonc-parser";
import { ungzip } from "pako";
import { parse as parseToml } from "smol-toml";

import { deleteDeployToken, DeployJobWriter, getDeployToken } from "./jobs";
import { trackEvent } from "./metrics";
import type { Account, AppEnv, DeployOptions, DeployStepId, DeployStepStatus } from "./types";

const COMPONENT_GATEWAY = "gateway";
const COMPONENT_RIPGIT = "ripgit";
const COMPONENT_ASSEMBLER = "assembler";
const COMPONENT_CHANNEL_WHATSAPP = "channel-whatsapp";
const COMPONENT_CHANNEL_DISCORD = "channel-discord";
const COMPONENT_CHANNEL_TELEGRAM = "channel-telegram";

const BUNDLE_CHECKSUMS = "cloudflare-checksums.txt";
const DEFAULT_DEPLOY_INSTANCE = "gsv";
const DEFAULT_STORAGE_BUCKET_NAME = "gsv-storage";
const SCRIPT_GATEWAY = "gsv";
const SCRIPT_ASSEMBLER = "gsv-assembler";
const SCRIPT_RIPGIT = "ripgit";
const SCRIPT_CHANNEL_WHATSAPP = "gsv-channel-whatsapp";
const SCRIPT_CHANNEL_DISCORD = "gsv-channel-discord";
const SCRIPT_CHANNEL_TELEGRAM = "gsv-channel-telegram";
const WORKERS_SUBDOMAIN_API_DATE = "2025-08-01";
const MAX_SOURCE_MAP_UPLOAD_BYTES = 2 * 1024 * 1024;
const DEPLOY_WORKFLOW_STEP_CONFIG = {
  timeout: "30 minutes",
  retries: { limit: 2, delay: "30 seconds", backoff: "linear" },
} as const;
const CLEANUP_WORKFLOW_STEP_CONFIG = {
  timeout: "2 minutes",
  retries: { limit: 3, delay: "10 seconds", backoff: "linear" },
} as const;

export const ALL_COMPONENTS = [
  COMPONENT_RIPGIT,
  COMPONENT_ASSEMBLER,
  COMPONENT_GATEWAY,
  COMPONENT_CHANNEL_WHATSAPP,
  COMPONENT_CHANNEL_DISCORD,
  COMPONENT_CHANNEL_TELEGRAM,
] as const;

const COMPONENT_TO_BUNDLE: Record<string, string> = {
  [COMPONENT_ASSEMBLER]: "gsv-cloudflare-assembler.tar.gz",
  [COMPONENT_GATEWAY]: "gsv-cloudflare-gateway.tar.gz",
  [COMPONENT_RIPGIT]: "gsv-cloudflare-ripgit.tar.gz",
  [COMPONENT_CHANNEL_WHATSAPP]: "gsv-cloudflare-channel-whatsapp.tar.gz",
  [COMPONENT_CHANNEL_DISCORD]: "gsv-cloudflare-channel-discord.tar.gz",
  [COMPONENT_CHANNEL_TELEGRAM]: "gsv-cloudflare-channel-telegram.tar.gz",
};

type GitHubRelease = {
  tag_name: string;
  name?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string | null;
};

export type ReleaseOption = {
  value: string;
  label: string;
  description: string;
};

export type ExistingGsvInstallation = {
  accountId: string;
  accountName: string;
  instance: string;
  components: string[];
  scriptNames: string[];
};

type BundleManifest = {
  component: string;
  worker: {
    entrypoint: string;
    sourceMap?: string;
    source_map?: string;
    wranglerConfig?: string;
    wrangler_config?: string;
  };
  assetsDir?: string;
  assets_dir?: string;
};

type WranglerConfig = {
  name: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  migrations?: unknown[];
  durable_objects?: {
    bindings?: Array<{
      name: string;
      class_name: string;
      script_name?: string;
      environment?: string;
    }>;
  };
  kv_namespaces?: Array<{
    binding: string;
    id?: string;
    preview_id?: string;
  }>;
  r2_buckets?: Array<{
    binding: string;
    bucket_name?: string;
    jurisdiction?: string;
  }>;
  services?: Array<{
    binding: string;
    service: string;
    environment?: string;
    entrypoint?: string;
  }>;
  worker_loaders?: Array<{ binding: string }>;
  ai?: { binding: string; staging?: boolean };
  assets?: {
    directory?: string;
    binding?: string;
    html_handling?: string;
    not_found_handling?: string;
    run_worker_first?: unknown;
  };
  observability?: unknown;
};

type PreparedBundle = {
  component: string;
  manifest: BundleManifest;
  files: Map<string, Uint8Array>;
  wrangler: WranglerConfig;
  scriptName: string;
  entrypointPartName: string;
  entrypointBytes: Uint8Array;
  additionalModules: WorkerModuleUpload[];
  sourceMap?: { name: string; bytes: Uint8Array };
};

type WorkerModuleUpload = {
  partName: string;
  bytes: Uint8Array;
  mimeType: string;
};

type UploadedAssets = {
  jwt: string;
  config: unknown;
};

type CloudflareApiMessage = {
  code?: number;
  message: string;
};

type CloudflareApiResponse<T> = {
  success: boolean;
  result: T;
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
};

type WorkerScriptSummary = {
  id: string;
  migration_tag?: string | null;
};

type AssetsUploadSessionResponse = {
  jwt?: string;
  buckets?: string[][];
};

type AssetsUploadBucketResponse = {
  jwt?: string;
};

type TarEntry = {
  path: string;
  bytes: Uint8Array;
};

type InfoLogger = {
  info(message: string): Promise<void>;
};

type DeploymentPlan = {
  repoOwner: string;
  repoName: string;
  version: string;
  instance: DeployInstance;
  components: string[];
  artifactCachePrefix: string;
};

type DeploymentPreflight = {
  existingScriptsWithMigrations: Array<[string, string | null]>;
  accountSubdomain: string | null;
};

type DeploymentWorkersState = {
  availableScripts: string[];
};

type DeploymentResult = {
  version: string;
  gatewayUrl?: string;
};

type DeploymentPhase = {
  accessToken: string;
  writer: DeployJobWriter;
  logger: DeployLogger;
};

type ReleaseArtifactSource =
  | { kind: "release"; snapshotPrefix: string }
  | { kind: "snapshot"; snapshotPrefix: string };

const SILENT_LOGGER: InfoLogger = {
  async info() {},
};

class DeployLogger {
  constructor(private readonly writer: DeployJobWriter) {}

  info(message: string): Promise<void> {
    return this.writer.appendLog("info", message);
  }

  warning(message: string): Promise<void> {
    return this.writer.appendLog("warning", message);
  }

  error(message: string): Promise<void> {
    return this.writer.appendLog("error", message);
  }

  step(stepId: DeployStepId, status: DeployStepStatus, detail?: string): Promise<void> {
    return this.writer.updateStep(stepId, status, detail);
  }
}

export async function fetchReleaseOptions(env: AppEnv["Bindings"]): Promise<ReleaseOption[]> {
  const options = defaultReleaseOptions();
  if (!env.GITHUB_TOKEN?.trim()) return options;

  const repoOwner = env.GSV_REPO_OWNER || "deathbyknowledge";
  const repoName = env.GSV_REPO_NAME || "gsv";
  const releases = await githubJson<GitHubRelease[]>(
    `https://api.github.com/repos/${repoOwner}/${repoName}/releases?per_page=50`,
    env,
  );
  for (const release of releases) {
    if (release.draft || !release.tag_name) continue;
    const suffix = release.prerelease ? " prerelease" : "";
    const date = release.published_at ? `, ${release.published_at.slice(0, 10)}` : "";
    options.push({
      value: release.tag_name,
      label: `${release.tag_name}${suffix}${date}`,
      description: release.name?.trim() || release.tag_name,
    });
  }

  return dedupeReleaseOptions(options);
}

function defaultReleaseOptions(): ReleaseOption[] {
  return [
    {
      value: "latest",
      label: "Latest stable",
      description: "Recommended for most installs.",
    },
    {
      value: "dev",
      label: "Dev channel",
      description: "Newest prerelease build.",
    },
  ];
}

export async function findExistingGsvInstallations(
  accessToken: string,
  accounts: Account[],
): Promise<ExistingGsvInstallation[]> {
  const installations: ExistingGsvInstallation[] = [];
  for (const account of accounts) {
    try {
      const scripts = await listWorkerScripts(accessToken, account.id);
      installations.push(...detectGsvInstallations(account, [...scripts.keys()]));
    } catch {
      // Account inspection is opportunistic. The deploy form should still render.
    }
  }
  return installations.sort((a, b) => {
    const account = a.accountName.localeCompare(b.accountName);
    return account || a.instance.localeCompare(b.instance);
  });
}

export async function runDeployJob(
  env: AppEnv["Bindings"],
  jobId: string,
  accessToken: string,
): Promise<void> {
  const writer = await DeployJobWriter.load(env, jobId);
  if (!writer) return;
  let plan: DeploymentPlan | null = null;

  try {
    const logger = new DeployLogger(writer);
    await writer.update({ status: "running" }, { flush: false });
    plan = await prepareDeploymentPlan(env, jobId, writer.job.options, logger);
    const preflight = await inspectDeploymentTarget(env, accessToken, writer.job.options.accountId, plan, logger);
    const workers = await deployWorkerScripts(env, accessToken, writer.job.options.accountId, plan, preflight, logger);
    await finalizeWorkerBindings(env, accessToken, writer.job.options.accountId, plan, preflight, workers, logger);
    const result = await configureAdaptersAndFinish(accessToken, writer.job.options, plan, preflight, logger);
    await recordDeploymentSuccess(env, writer, result);
  } catch (error) {
    await recordDeploymentFailureWithWriter(env, writer, error);
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  } finally {
    await writer.flush();
    if (plan) await cleanupDeploymentArtifacts(env, plan, SILENT_LOGGER);
  }
}

export async function runDeployWorkflow(
  env: AppEnv["Bindings"],
  jobId: string,
  step: WorkflowStep,
): Promise<void> {
  let plan: DeploymentPlan | null = null;
  try {
    plan = await step.do("prepare deployment", DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, async ({ writer, logger }) => {
        await writer.update({ status: "running" }, { flush: false });
        return prepareDeploymentPlan(env, jobId, writer.job.options, logger);
      }),
    );
    if (!plan) return;
    const deploymentPlan = plan;

    const preflight = await step.do("inspect target and ensure storage", DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, ({ accessToken, writer, logger }) =>
        inspectDeploymentTarget(env, accessToken, writer.job.options.accountId, deploymentPlan, logger),
      ),
    );
    if (!preflight) return;

    const workers = await step.do("deploy worker scripts", DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, ({ accessToken, writer, logger }) =>
        deployWorkerScripts(env, accessToken, writer.job.options.accountId, deploymentPlan, preflight, logger),
      ),
    );
    if (!workers) return;

    const bindingsFinalized = await step.do("finalize worker bindings", DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, async ({ accessToken, writer, logger }) => {
        await finalizeWorkerBindings(env, accessToken, writer.job.options.accountId, deploymentPlan, preflight, workers, logger);
        return { ok: true };
      }),
    );
    if (!bindingsFinalized) return;

    await step.do("configure adapters and finish", DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, async ({ accessToken, writer, logger }) => {
        const result = await configureAdaptersAndFinish(accessToken, writer.job.options, deploymentPlan, preflight, logger);
        await recordDeploymentSuccess(env, writer, result);
        return result;
      }),
    );
  } catch (error) {
    await step.do("record deployment failure", CLEANUP_WORKFLOW_STEP_CONFIG, async () => {
      await recordDeploymentFailure(env, jobId, error);
      return { ok: true };
    });
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  } finally {
    try {
      await step.do("cleanup deployment credentials", CLEANUP_WORKFLOW_STEP_CONFIG, async () => {
        if (plan) await cleanupDeploymentArtifacts(env, plan, SILENT_LOGGER);
        await deleteDeployToken(env, jobId);
        return { ok: true };
      });
    } catch {
      // The deploy token also has a short TTL; cleanup should not mask the deployment result.
    }
  }
}

async function withDeploymentPhase<T>(
  env: AppEnv["Bindings"],
  jobId: string,
  callback: (phase: DeploymentPhase) => Promise<T>,
): Promise<T | null> {
  const phase = await loadDeploymentPhase(env, jobId);
  if (!phase) return null;
  try {
    return await callback(phase);
  } finally {
    await phase.writer.flush();
  }
}

async function loadDeploymentPhase(env: AppEnv["Bindings"], jobId: string): Promise<DeploymentPhase | null> {
  const writer = await DeployJobWriter.load(env, jobId);
  if (!writer) return null;

  const accessToken = await getDeployToken(env, jobId);
  if (!accessToken) {
    const message = "Deployment credentials expired before the workflow started. Please authorize Cloudflare again.";
    await recordDeploymentFailureWithWriter(env, writer, message);
    throw new Error(message);
  }

  return { accessToken, writer, logger: new DeployLogger(writer) };
}

async function prepareDeploymentPlan(
  env: AppEnv["Bindings"],
  jobId: string,
  options: DeployOptions,
  logger: DeployLogger,
): Promise<DeploymentPlan> {
  const instance = parseInstance(options.instance);
  const components = normalizeComponents(options.components).sort((a, b) => deployOrder(a) - deployOrder(b));
  if (components.length === 0) throw new Error("No components selected.");

  const repoOwner = env.GSV_REPO_OWNER || "deathbyknowledge";
  const repoName = env.GSV_REPO_NAME || "gsv";
  await logger.step("release", "running", "Looking up the requested GSV release.");
  const version = await resolveReleaseTag(repoOwner, repoName, options.version, logger);
  await logger.step("release", "complete", `Using ${version}.`);
  await logger.info(`Preparing ${components.join(", ")} from ${version}.`);

  await logger.step("prepare", "running", `Downloading and verifying ${formatCount(components.length, "component")}.`);
  const artifactCachePrefix = deploymentArtifactCachePrefix(jobId);
  await prepareBundles(env, repoOwner, repoName, version, components, instance, logger, {
    kind: "release",
    snapshotPrefix: artifactCachePrefix,
  });
  await logger.step("prepare", "complete", "GSV components are verified and ready.");

  return { repoOwner, repoName, version, instance, components, artifactCachePrefix };
}

async function inspectDeploymentTarget(
  env: AppEnv["Bindings"],
  accessToken: string,
  accountId: string,
  plan: DeploymentPlan,
  logger: DeployLogger,
): Promise<DeploymentPreflight> {
  const selectedComponents = new Set(plan.components);
  const ripgitScriptName = scriptNameForComponent(plan.instance, COMPONENT_RIPGIT);
  const assemblerScriptName = scriptNameForComponent(plan.instance, COMPONENT_ASSEMBLER);

  const existingScriptsWithMigrations = await listWorkerScripts(accessToken, accountId);
  const existingScripts = new Set([...existingScriptsWithMigrations.keys()]);

  if (selectedComponents.has(COMPONENT_GATEWAY) && !selectedComponents.has(COMPONENT_RIPGIT) && !existingScripts.has(ripgitScriptName)) {
    throw new Error("Deploying gateway requires ripgit. Select ripgit or deploy it first.");
  }
  if (selectedComponents.has(COMPONENT_GATEWAY) && !selectedComponents.has(COMPONENT_ASSEMBLER) && !existingScripts.has(assemblerScriptName)) {
    throw new Error("Deploying gateway requires assembler. Select assembler or deploy it first.");
  }

  await logger.step("storage", "running", "Checking Cloudflare storage resources.");
  const prepared = await prepareBundlesForPhase(env, plan, logger, "Loading verified bundles for storage checks.");
  await ensureStorageResources(accessToken, accountId, prepared, logger);
  await logger.step("storage", "complete", "Storage resources are ready.");

  const accountSubdomain = await fetchAccountWorkersSubdomain(accessToken, accountId, logger);
  return { existingScriptsWithMigrations: [...existingScriptsWithMigrations], accountSubdomain };
}

async function deployWorkerScripts(
  env: AppEnv["Bindings"],
  accessToken: string,
  accountId: string,
  plan: DeploymentPlan,
  preflight: DeploymentPreflight,
  logger: DeployLogger,
): Promise<DeploymentWorkersState> {
  const prepared = await prepareBundlesForPhase(env, plan, logger, "Loading verified bundles for Worker upload.");
  const selectedComponents = new Set(plan.components);
  const currentScriptsWithMigrations = await listWorkerScripts(accessToken, accountId);
  const existingScriptsWithMigrations = new Map([
    ...preflight.existingScriptsWithMigrations,
    ...currentScriptsWithMigrations,
  ]);
  const accountSubdomain = preflight.accountSubdomain;
  const availableScripts = new Set(existingScriptsWithMigrations.keys());

  await logger.step("workers", "running", `Uploading ${formatCount(prepared.length, "Worker")}.`);
  await logger.info("Deploying workers (pass 1/2).");
  for (const bundle of prepared) {
    await logger.info(`Deploying ${bundle.component} (${bundle.scriptName}).`);
    const uploadedAssets = await syncAssetsForBundle(accessToken, accountId, bundle, logger);

    const metadata = await buildUploadMetadata(accessToken, accountId, bundle, {
      instance: plan.instance,
      selectedComponents,
      availableScripts,
      accountSubdomain,
      existingMigrationTag: existingScriptsWithMigrations.get(bundle.scriptName) ?? null,
      includeMigrations: true,
      scriptExists: existingScriptsWithMigrations.has(bundle.scriptName),
      uploadedAssets,
      keepAssets: false,
      logger,
    });
    await uploadWorkerScript(accessToken, accountId, bundle, metadata, false);
    await logger.info(`Uploaded ${bundle.scriptName}.`);
    availableScripts.add(bundle.scriptName);
    await enableWorkersDev(accessToken, accountId, bundle.scriptName, logger);
  }
  await logger.step("workers", "complete", "Workers and assets are deployed.");

  return { availableScripts: [...availableScripts].sort() };
}

async function finalizeWorkerBindings(
  env: AppEnv["Bindings"],
  accessToken: string,
  accountId: string,
  plan: DeploymentPlan,
  preflight: DeploymentPreflight,
  workers: DeploymentWorkersState,
  logger: DeployLogger,
): Promise<void> {
  const prepared = await prepareBundlesForPhase(env, plan, logger, "Loading verified bundles for binding finalization.");
  const selectedComponents = new Set(plan.components);
  const availableScripts = new Set(workers.availableScripts);
  const accountSubdomain = preflight.accountSubdomain;

  await logger.step("bindings", "running", "Connecting GSV services.");
  await logger.info("Finalizing service bindings (pass 2/2).");
  for (const bundle of prepared) {
    await logger.info(`Finalizing ${bundle.component} (${bundle.scriptName}).`);
    const metadata = await buildUploadMetadata(accessToken, accountId, bundle, {
      instance: plan.instance,
      selectedComponents,
      availableScripts,
      accountSubdomain,
      existingMigrationTag: null,
      includeMigrations: false,
      scriptExists: true,
      uploadedAssets: null,
      keepAssets: hasAssets(bundle),
      logger,
    });
    await uploadWorkerScript(accessToken, accountId, bundle, metadata, true);
    await logger.info(`Updated bindings for ${bundle.scriptName}.`);
  }
  await logger.step("bindings", "complete", "GSV services are connected.");
}

async function configureAdaptersAndFinish(
  accessToken: string,
  options: DeployOptions,
  plan: DeploymentPlan,
  preflight: DeploymentPreflight,
  logger: DeployLogger,
): Promise<DeploymentResult> {
  const selectedComponents = new Set(plan.components);
  const accountSubdomain = preflight.accountSubdomain;
  const gatewayScriptName = scriptNameForComponent(plan.instance, COMPONENT_GATEWAY);

  const hasChannelComponents = [...selectedComponents].some((component) => component.startsWith("channel-"));
  if (hasChannelComponents) {
    await logger.step("adapters", "running", "Applying channel configuration.");
  }
  const adapterNotes: string[] = [];
  if (selectedComponents.has(COMPONENT_CHANNEL_DISCORD) && options.discordBotToken) {
    await setWorkerSecret(
      accessToken,
      options.accountId,
      scriptNameForComponent(plan.instance, COMPONENT_CHANNEL_DISCORD),
      "DISCORD_BOT_TOKEN",
      options.discordBotToken,
    );
    await logger.info("Configured DISCORD_BOT_TOKEN.");
  } else if (selectedComponents.has(COMPONENT_CHANNEL_DISCORD)) {
    adapterNotes.push("Discord needs a bot token before it can receive messages.");
  }

  if (selectedComponents.has(COMPONENT_CHANNEL_TELEGRAM) && options.telegramBotToken) {
    await setWorkerSecret(
      accessToken,
      options.accountId,
      scriptNameForComponent(plan.instance, COMPONENT_CHANNEL_TELEGRAM),
      "TELEGRAM_BOT_TOKEN",
      options.telegramBotToken,
    );
    await logger.info("Configured TELEGRAM_BOT_TOKEN.");
  } else if (selectedComponents.has(COMPONENT_CHANNEL_TELEGRAM)) {
    adapterNotes.push("Telegram needs a bot token before it can receive messages.");
  }
  if (selectedComponents.has(COMPONENT_CHANNEL_TELEGRAM) && !accountSubdomain) {
    adapterNotes.push("Telegram webhook URL could not be set because the workers.dev subdomain was unavailable.");
  }
  if (hasChannelComponents) {
    await logger.step(
      "adapters",
      adapterNotes.length > 0 ? "warning" : "complete",
      adapterNotes.length > 0 ? adapterNotes.join(" ") : "Channel settings are ready.",
    );
  }

  await logger.step("finish", "running", "Preparing the setup link.");
  const gatewayUrl =
    selectedComponents.has(COMPONENT_GATEWAY) && accountSubdomain
      ? workersDevUrl(gatewayScriptName, accountSubdomain)
      : undefined;
  if (gatewayUrl) await logger.info(`Gateway URL: ${gatewayUrl}`);
  await logger.step(
    "finish",
    selectedComponents.has(COMPONENT_GATEWAY) && !gatewayUrl ? "warning" : "complete",
    gatewayUrl
      ? "GSV is ready for browser setup."
      : selectedComponents.has(COMPONENT_GATEWAY)
        ? "GSV deployed, but the workers.dev setup URL was unavailable. Open the gateway Worker from the Cloudflare dashboard."
        : "Selected components are deployed.",
  );

  return { version: plan.version, gatewayUrl };
}

async function prepareBundlesForPhase(
  env: AppEnv["Bindings"],
  plan: DeploymentPlan,
  logger: DeployLogger,
  message: string,
): Promise<PreparedBundle[]> {
  await logger.info(message);
  return prepareBundles(env, plan.repoOwner, plan.repoName, plan.version, plan.components, plan.instance, SILENT_LOGGER, {
    kind: "snapshot",
    snapshotPrefix: plan.artifactCachePrefix,
  });
}

async function recordDeploymentSuccess(
  env: AppEnv["Bindings"],
  writer: DeployJobWriter,
  result: DeploymentResult,
): Promise<void> {
  const account = writer.job.options.accountName || writer.job.options.accountId;
  await writer.update({ status: "succeeded", result }, { flush: false });
  await writer.appendLog("info", "Deployment complete.", { flush: false });
  trackEvent(env, "deploy_success", writer.job.options.version, "", writer.job.id, writer.job.options.instance, account);
  await writer.flush(true);
}

async function recordDeploymentFailure(env: AppEnv["Bindings"], jobId: string, error: unknown): Promise<void> {
  const writer = await DeployJobWriter.load(env, jobId);
  if (!writer) return;
  await recordDeploymentFailureWithWriter(env, writer, error);
}

async function recordDeploymentFailureWithWriter(
  env: AppEnv["Bindings"],
  writer: DeployJobWriter,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (writer.job.status === "failed" && writer.job.error === message) {
    return;
  }

  const account = writer.job.options.accountName || writer.job.options.accountId;
  await writer.failActiveStep(friendlyErrorDetail(message), { flush: false });
  await writer.appendLog("error", message, { flush: false });
  await writer.update({ status: "failed", error: message }, { flush: false });
  trackEvent(env, "deploy_failed", writer.job.options.version, "", writer.job.id, writer.job.options.instance, account);
  await writer.flush(true);
}

function normalizeComponents(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const component of raw) {
    if (!COMPONENT_TO_BUNDLE[component]) throw new Error(`Unknown component: ${component}`);
    if (!seen.has(component)) {
      seen.add(component);
      out.push(component);
    }
  }
  return out;
}

function dedupeReleaseOptions(options: ReleaseOption[]): ReleaseOption[] {
  const seen = new Set<string>();
  const out: ReleaseOption[] = [];
  for (const option of options) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    out.push(option);
  }
  return out;
}

function detectGsvInstallations(account: Account, scriptNames: string[]): ExistingGsvInstallation[] {
  const scripts = new Set(scriptNames);
  const instances = new Map<string, Set<string>>();
  for (const scriptName of scripts) {
    const match = componentForScriptName(scriptName);
    if (!match) continue;
    let components = instances.get(match.instance);
    if (!components) {
      components = new Set<string>();
      instances.set(match.instance, components);
    }
    components.add(match.component);
  }

  for (const instance of instances.keys()) {
    if (scripts.has(instance)) instances.get(instance)?.add(COMPONENT_GATEWAY);
  }
  if (scripts.has(SCRIPT_GATEWAY)) {
    let components = instances.get(DEFAULT_DEPLOY_INSTANCE);
    if (!components) {
      components = new Set<string>();
      instances.set(DEFAULT_DEPLOY_INSTANCE, components);
    }
    components.add(COMPONENT_GATEWAY);
  }

  return [...instances]
    .filter(([, components]) => components.size > 0)
    .map(([instance, components]) => ({
      accountId: account.id,
      accountName: account.name?.trim() || account.id,
      instance,
      components: [...components].sort((a, b) => deployOrder(a) - deployOrder(b)),
      scriptNames: scriptNamesForDetectedInstance(instance, components).filter((name) => scripts.has(name)),
    }));
}

function componentForScriptName(scriptName: string): { instance: string; component: string } | null {
  if (scriptName === SCRIPT_RIPGIT) return { instance: DEFAULT_DEPLOY_INSTANCE, component: COMPONENT_RIPGIT };
  const suffixes: Array<[string, string]> = [
    ["-channel-whatsapp", COMPONENT_CHANNEL_WHATSAPP],
    ["-channel-discord", COMPONENT_CHANNEL_DISCORD],
    ["-channel-telegram", COMPONENT_CHANNEL_TELEGRAM],
    ["-assembler", COMPONENT_ASSEMBLER],
    ["-ripgit", COMPONENT_RIPGIT],
  ];
  for (const [suffix, component] of suffixes) {
    if (!scriptName.endsWith(suffix)) continue;
    const instance = scriptName.slice(0, -suffix.length);
    return instance ? { instance, component } : null;
  }
  return scriptName === SCRIPT_GATEWAY ? { instance: DEFAULT_DEPLOY_INSTANCE, component: COMPONENT_GATEWAY } : null;
}

function scriptNamesForDetectedInstance(instance: string, components: Set<string>): string[] {
  const deployInstance: DeployInstance = {
    name: instance,
    isDefault: instance === DEFAULT_DEPLOY_INSTANCE,
    storageBucketName: `${instance}-storage`,
  };
  return [...components].map((component) => scriptNameForComponent(deployInstance, component));
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function friendlyErrorDetail(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("credentials expired") || lower.includes("authorize cloudflare")) {
    return "Your Cloudflare authorization expired. Start a new deployment and authorize Cloudflare again.";
  }
  if (lower.includes("instance name")) {
    return "The GSV instance name is not valid. Use lowercase letters, numbers, and dashes only.";
  }
  if (lower.includes("no components selected") || lower.includes("unknown component")) {
    return "Choose at least one valid GSV component and try the deployment again.";
  }
  if (lower.includes("invalid account") || lower.includes("authentication") || lower.includes("unauthorized")) {
    return "Cloudflare did not accept this authorization. Log in again and approve the requested account access.";
  }
  if (lower.includes("forbidden") || lower.includes("permission") || lower.includes("scope")) {
    return "Cloudflare rejected a deployment request. Reauthorize with the required scopes or check account permissions.";
  }
  if (lower.includes("latest stable release") || lower.includes("no dev") || lower.includes("release")) {
    return "The selected GSV release is not available. Try the stable channel, the dev channel, or a specific release tag.";
  }
  if (lower.includes("checksum")) {
    return "The downloaded release bundle did not match its checksum. Retry the deployment or choose another release.";
  }
  if (lower.includes("r2 bucket") || lower.includes("storage/kv") || lower.includes("kv namespace")) {
    return "Cloudflare could not prepare storage for this GSV. Check that the account has access to the required Workers storage products.";
  }
  if (lower.includes("workers/scripts") || lower.includes("upload script") || lower.includes("workers.dev")) {
    return "Cloudflare could not deploy or expose one of the Workers. Check Workers permissions and account limits.";
  }
  if (lower.includes("requires ripgit") || lower.includes("requires assembler")) {
    return "The gateway depends on ripgit and assembler. Select those components or deploy them first.";
  }
  return "Deployment stopped before this step finished. The diagnostics below include the exact service response.";
}

function deployOrder(component: string): number {
  switch (component) {
    case COMPONENT_RIPGIT:
      return 0;
    case COMPONENT_ASSEMBLER:
      return 1;
    case COMPONENT_CHANNEL_WHATSAPP:
      return 2;
    case COMPONENT_CHANNEL_DISCORD:
      return 3;
    case COMPONENT_CHANNEL_TELEGRAM:
      return 4;
    case COMPONENT_GATEWAY:
      return 10;
    default:
      return 100;
  }
}

type DeployInstance = {
  name: string;
  isDefault: boolean;
  storageBucketName: string;
};

function parseInstance(raw: string): DeployInstance {
  const name = raw.trim().toLowerCase() || DEFAULT_DEPLOY_INSTANCE;
  if (name.startsWith("-") || name.endsWith("-")) {
    throw new Error("GSV instance name cannot start or end with '-'.");
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error("GSV instance name must contain only lowercase letters, numbers, and '-'.");
  }
  if (
    name !== DEFAULT_DEPLOY_INSTANCE &&
    (name === SCRIPT_RIPGIT ||
      ["-assembler", "-ripgit", "-channel-whatsapp", "-channel-discord", "-channel-telegram"].some((suffix) =>
        name.endsWith(suffix),
      ))
  ) {
    throw new Error("GSV instance name would collide with generated component worker names.");
  }

  return {
    name,
    isDefault: name === DEFAULT_DEPLOY_INSTANCE,
    storageBucketName: `${name}-storage`,
  };
}

function scriptNameForComponent(instance: DeployInstance, component: string): string {
  switch (component) {
    case COMPONENT_GATEWAY:
      return instance.name;
    case COMPONENT_ASSEMBLER:
      return `${instance.name}-assembler`;
    case COMPONENT_RIPGIT:
      return instance.isDefault ? SCRIPT_RIPGIT : `${instance.name}-ripgit`;
    case COMPONENT_CHANNEL_WHATSAPP:
      return `${instance.name}-channel-whatsapp`;
    case COMPONENT_CHANNEL_DISCORD:
      return `${instance.name}-channel-discord`;
    case COMPONENT_CHANNEL_TELEGRAM:
      return `${instance.name}-channel-telegram`;
    default:
      throw new Error(`Unsupported component: ${component}`);
  }
}

function scriptNameForConfigService(instance: DeployInstance, service: string): string {
  switch (service) {
    case SCRIPT_GATEWAY:
      return scriptNameForComponent(instance, COMPONENT_GATEWAY);
    case SCRIPT_ASSEMBLER:
      return scriptNameForComponent(instance, COMPONENT_ASSEMBLER);
    case SCRIPT_RIPGIT:
      return scriptNameForComponent(instance, COMPONENT_RIPGIT);
    case SCRIPT_CHANNEL_WHATSAPP:
      return scriptNameForComponent(instance, COMPONENT_CHANNEL_WHATSAPP);
    case SCRIPT_CHANNEL_DISCORD:
      return scriptNameForComponent(instance, COMPONENT_CHANNEL_DISCORD);
    case SCRIPT_CHANNEL_TELEGRAM:
      return scriptNameForComponent(instance, COMPONENT_CHANNEL_TELEGRAM);
    default:
      return service;
  }
}

async function resolveReleaseTag(
  repoOwner: string,
  repoName: string,
  version: string,
  logger: InfoLogger,
): Promise<string> {
  const normalized = version.trim().toLowerCase() || "latest";
  if (normalized === "latest" || normalized === "stable") {
    await logger.info("Resolving latest stable release.");
    return resolveLatestStableReleaseTag(repoOwner, repoName);
  }

  if (normalized === "dev") {
    await logger.info("Using dev release channel.");
    return "dev";
  }

  return version.trim();
}

async function resolveLatestStableReleaseTag(repoOwner: string, repoName: string): Promise<string> {
  const response = await fetch(`https://github.com/${repoOwner}/${repoName}/releases/latest`, {
    redirect: "manual",
    headers: { "User-Agent": "gsv-deployment" },
  });

  const location = response.headers.get("Location");
  const tag = location ? extractReleaseTag(location) : extractReleaseTag(response.url);
  if (tag && isStableSemverTag(tag)) return tag;

  if (response.ok) {
    const html = await response.text();
    const escapedOwner = escapeRegExp(repoOwner);
    const escapedRepo = escapeRegExp(repoName);
    const match = html.match(new RegExp(`/${escapedOwner}/${escapedRepo}/releases/tag/([^"?#<>]+)`));
    const htmlTag = match?.[1] ? decodeURIComponent(match[1]) : null;
    if (htmlTag && isStableSemverTag(htmlTag)) return htmlTag;
  }

  throw new Error(`Could not resolve latest stable release from GitHub releases redirect (${response.status}).`);
}

function extractReleaseTag(value: string): string | null {
  try {
    const url = new URL(value, "https://github.com");
    const parts = url.pathname.split("/").filter(Boolean);
    const tagIndex = parts.indexOf("tag");
    return tagIndex >= 0 && parts[tagIndex + 1] ? decodeURIComponent(parts[tagIndex + 1]) : null;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isStableSemverTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

async function githubJson<T>(url: string, env: AppEnv["Bindings"]): Promise<T> {
  const response = await githubApiFetch(url, env);
  return parseJsonResponse(response, url) as Promise<T>;
}

function githubApiFetch(url: string, env: AppEnv["Bindings"]): Promise<Response> {
  return fetch(url, { headers: githubApiHeaders(env) });
}

function githubApiHeaders(env: AppEnv["Bindings"]): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "gsv-deployment",
  };
  const token = env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function prepareBundles(
  env: AppEnv["Bindings"],
  repoOwner: string,
  repoName: string,
  version: string,
  components: string[],
  instance: DeployInstance,
  logger: InfoLogger,
  source: ReleaseArtifactSource,
): Promise<PreparedBundle[]> {
  const checksumsUrl = releaseDownloadUrl(repoOwner, repoName, version, BUNDLE_CHECKSUMS);
  await logger.info(`Fetching checksums from ${checksumsUrl}.`);
  const checksumsText = await fetchReleaseAssetText(env, repoOwner, repoName, version, BUNDLE_CHECKSUMS, "Fetch bundle checksums", logger, source);
  const checksums = parseChecksums(checksumsText);
  const bundles: PreparedBundle[] = [];

  for (const component of components) {
    const bundleFile = COMPONENT_TO_BUNDLE[component];
    const expected = checksums.get(bundleFile);
    if (!expected) throw new Error(`Missing checksum entry for ${bundleFile}.`);

    await logger.info(`Downloading ${component} bundle.`);
    const bytes = await fetchReleaseAssetBytes(env, repoOwner, repoName, version, bundleFile, `Download ${component} bundle`, logger, source);
    const actual = await sha256Hex(bytes);
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${bundleFile}: expected ${expected}, got ${actual}.`);
    }
    await logger.info(`Checksum OK for ${bundleFile}.`);
    bundles.push(await prepareBundle(component, bytes, instance));
  }

  return bundles.sort((a, b) => deployOrder(a.component) - deployOrder(b.component));
}

function releaseDownloadUrl(repoOwner: string, repoName: string, tag: string, fileName: string): string {
  const base = `https://github.com/${repoOwner}/${repoName}/releases/download/${tag}/${fileName}`;
  return tag.toLowerCase() === "dev" ? `${base}?ts=${Date.now()}` : base;
}

async function fetchReleaseAssetText(
  env: AppEnv["Bindings"],
  repoOwner: string,
  repoName: string,
  version: string,
  fileName: string,
  context: string,
  logger: InfoLogger,
  source: ReleaseArtifactSource,
): Promise<string> {
  return decodeText(await fetchReleaseAssetBytes(env, repoOwner, repoName, version, fileName, context, logger, source));
}

async function fetchReleaseAssetBytes(
  env: AppEnv["Bindings"],
  repoOwner: string,
  repoName: string,
  version: string,
  fileName: string,
  context: string,
  logger: InfoLogger,
  source: ReleaseArtifactSource,
): Promise<Uint8Array> {
  if (source.kind === "snapshot") {
    return readRequiredReleaseAssetCache(
      env.RELEASE_CACHE,
      deploymentArtifactCacheKey(source.snapshotPrefix, fileName),
      fileName,
    );
  }

  const url = releaseDownloadUrl(repoOwner, repoName, version, fileName);
  let bytes: Uint8Array | null = null;

  if (shouldCacheReleaseAsset(version)) {
    const key = releaseCacheKey(repoOwner, repoName, version, fileName);
    bytes = await readReleaseAssetCache(env.RELEASE_CACHE, key, fileName, logger);
    if (!bytes) {
      bytes = await fetchBytes(url, context);
      await writeReleaseAssetCache(env.RELEASE_CACHE, key, fileName, repoOwner, repoName, version, bytes, logger);
    }
  } else {
    bytes = await fetchBytes(url, context);
  }

  await writeDeploymentArtifactCache(env.RELEASE_CACHE, source.snapshotPrefix, fileName, repoOwner, repoName, version, bytes);
  return bytes;
}

function shouldCacheReleaseAsset(version: string): boolean {
  // The dev channel is mutable and intentionally cache-busted at the GitHub URL level.
  return version.trim().toLowerCase() !== "dev";
}

function releaseCacheKey(repoOwner: string, repoName: string, version: string, fileName: string): string {
  return [
    "github",
    encodeURIComponent(repoOwner),
    encodeURIComponent(repoName),
    "releases",
    encodeURIComponent(version),
    encodeURIComponent(fileName),
  ].join("/");
}

function deploymentArtifactCachePrefix(jobId: string): string {
  return ["deployments", encodeURIComponent(jobId), "release-artifacts"].join("/");
}

function deploymentArtifactCacheKey(prefix: string, fileName: string): string {
  return `${prefix}/${encodeURIComponent(fileName)}`;
}

async function readRequiredReleaseAssetCache(
  cache: R2Bucket,
  key: string,
  fileName: string,
): Promise<Uint8Array> {
  try {
    const object = await cache.get(key);
    if (!object) throw new Error("object not found");
    return new Uint8Array(await object.arrayBuffer());
  } catch (error) {
    throw new Error(`Verified deployment artifact ${fileName} is unavailable in R2: ${errorMessage(error)}`);
  }
}

async function readReleaseAssetCache(
  cache: R2Bucket,
  key: string,
  fileName: string,
  logger: InfoLogger,
): Promise<Uint8Array | null> {
  try {
    const object = await cache.get(key);
    if (!object) return null;
    await logger.info(`Release cache hit for ${fileName}.`);
    return new Uint8Array(await object.arrayBuffer());
  } catch (error) {
    await logger.info(`Release cache read failed for ${fileName}: ${errorMessage(error)}. Falling back to GitHub.`);
    return null;
  }
}

async function writeDeploymentArtifactCache(
  cache: R2Bucket,
  prefix: string,
  fileName: string,
  repoOwner: string,
  repoName: string,
  version: string,
  bytes: Uint8Array,
): Promise<void> {
  await cache.put(deploymentArtifactCacheKey(prefix, fileName), bytes, {
    httpMetadata: { contentType: releaseAssetContentType(fileName) },
    customMetadata: {
      source: "deployment-release-artifact",
      repo: `${repoOwner}/${repoName}`,
      version,
      file: fileName,
      cached_at: new Date().toISOString(),
    },
  });
}

async function writeReleaseAssetCache(
  cache: R2Bucket,
  key: string,
  fileName: string,
  repoOwner: string,
  repoName: string,
  version: string,
  bytes: Uint8Array,
  logger: InfoLogger,
): Promise<void> {
  try {
    await cache.put(key, bytes, {
      httpMetadata: { contentType: releaseAssetContentType(fileName) },
      customMetadata: {
        source: "github-release",
        repo: `${repoOwner}/${repoName}`,
        version,
        file: fileName,
        cached_at: new Date().toISOString(),
      },
    });
    await logger.info(`Cached ${fileName} in release cache.`);
  } catch (error) {
    await logger.info(`Release cache write failed for ${fileName}: ${errorMessage(error)}. Continuing with GitHub bytes.`);
  }
}

function releaseAssetContentType(fileName: string): string {
  if (fileName.endsWith(".tar.gz")) return "application/gzip";
  if (fileName.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupDeploymentArtifacts(
  env: AppEnv["Bindings"],
  plan: DeploymentPlan,
  logger: InfoLogger,
): Promise<void> {
  try {
    await env.RELEASE_CACHE.delete(deploymentArtifactCacheKeys(plan));
  } catch (error) {
    await logger.info(`Failed to clean up deployment release artifacts: ${errorMessage(error)}.`);
  }
}

function deploymentArtifactCacheKeys(plan: DeploymentPlan): string[] {
  return [
    BUNDLE_CHECKSUMS,
    ...plan.components.map((component) => COMPONENT_TO_BUNDLE[component]).filter(Boolean),
  ].map((fileName) => deploymentArtifactCacheKey(plan.artifactCachePrefix, fileName));
}

function parseChecksums(content: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [hash, file] = trimmed.split(/\s+/);
    if (hash && file) checksums.set(file, hash.toLowerCase());
  }
  return checksums;
}

async function prepareBundle(
  component: string,
  compressedBytes: Uint8Array,
  instance: DeployInstance,
): Promise<PreparedBundle> {
  const entries = parseTar(ungzip(compressedBytes));
  const files = normalizeBundleFiles(entries, component);
  const manifest = readJson<BundleManifest>(files, "manifest.json");
  const wranglerPath = manifest.worker.wranglerConfig ?? manifest.worker.wrangler_config ?? "wrangler.jsonc";
  const wrangler = parseWranglerConfig(wranglerPath, readText(files, wranglerPath));
  wrangler.name = scriptNameForComponent(instance, component);

  for (const bucket of wrangler.r2_buckets ?? []) {
    if (bucket.bucket_name === DEFAULT_STORAGE_BUCKET_NAME) {
      bucket.bucket_name = instance.storageBucketName;
    }
  }

  const entrypoint = normalizePath(manifest.worker.entrypoint);
  const entrypointBytes = readFile(files, entrypoint);
  const entrypointPartName = basename(entrypoint);
  const sourceMapPath = manifest.worker.sourceMap ?? manifest.worker.source_map;
  const sourceMapBytes = sourceMapPath && files.get(normalizePath(sourceMapPath));
  const sourceMap =
    sourceMapPath && sourceMapBytes && sourceMapBytes.byteLength <= MAX_SOURCE_MAP_UPLOAD_BYTES
      ? { name: basename(sourceMapPath), bytes: sourceMapBytes }
      : undefined;

  return {
    component,
    manifest,
    files,
    wrangler,
    scriptName: wrangler.name,
    entrypointPartName,
    entrypointBytes,
    additionalModules: collectAdditionalWorkerModules(files, entrypoint),
    sourceMap,
  };
}

function parseWranglerConfig(path: string, raw: string): WranglerConfig {
  const parsed = path.endsWith(".toml") ? parseToml(raw) : parseJsonc(raw);
  if (!isRecord(parsed) || typeof parsed.name !== "string" || !parsed.name.trim()) {
    throw new Error(`Wrangler config ${path} is missing worker name.`);
  }
  return parsed as WranglerConfig;
}

function normalizeBundleFiles(entries: TarEntry[], component: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const prefix = `${component}/`;
  for (const entry of entries) {
    let path = normalizePath(entry.path);
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
    if (!path || isSkippablePath(path)) continue;
    out.set(path, entry.bytes);
  }
  return out;
}

function collectAdditionalWorkerModules(files: Map<string, Uint8Array>, entrypoint: string): WorkerModuleUpload[] {
  const workerRoot = dirname(entrypoint);
  const out: WorkerModuleUpload[] = [];
  for (const [path, bytes] of files) {
    if (!path.startsWith(workerRoot ? `${workerRoot}/` : "")) continue;
    if (path === entrypoint || path.endsWith(".map") || isSkippablePath(path)) continue;
    const partName = workerRoot ? path.slice(workerRoot.length + 1) : path;
    out.push({ partName, bytes, mimeType: workerModuleMimeType(partName) });
  }
  return out.sort((a, b) => a.partName.localeCompare(b.partName));
}

function workerModuleMimeType(partName: string): string {
  const ext = extension(partName);
  switch (ext) {
    case "js":
    case "mjs":
      return "application/javascript+module";
    case "cjs":
      return "application/javascript";
    case "wasm":
      return "application/wasm";
    case "txt":
    case "html":
    case "sql":
    case "md":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

async function ensureStorageResources(
  accessToken: string,
  accountId: string,
  bundles: PreparedBundle[],
  logger: DeployLogger,
): Promise<void> {
  const r2Buckets = new Map<string, string | undefined>();
  for (const bundle of bundles) {
    for (const bucket of bundle.wrangler.r2_buckets ?? []) {
      if (!bucket.bucket_name) throw new Error(`${bundle.scriptName} has R2 binding ${bucket.binding} without bucket_name.`);
      r2Buckets.set(bucket.bucket_name, bucket.jurisdiction);
    }
  }

  if (r2Buckets.size > 0) await logger.info("Ensuring R2 buckets.");
  for (const [bucketName, jurisdiction] of [...r2Buckets].sort()) {
    const created = await ensureR2Bucket(accessToken, accountId, bucketName, jurisdiction);
    await logger.info(created ? `Created R2 bucket ${bucketName}.` : `R2 bucket ${bucketName} already exists.`);
  }
}

async function listWorkerScripts(accessToken: string, accountId: string): Promise<Map<string, string | null>> {
  const result = await cloudflareApi<unknown>(accessToken, `/accounts/${accountId}/workers/scripts`, {}, "List Workers scripts");
  const scripts = decodeList<WorkerScriptSummary>(result, ["scripts", "items"]);
  const out = new Map<string, string | null>();
  for (const script of scripts) out.set(script.id, script.migration_tag ?? null);
  return out;
}

async function ensureR2Bucket(
  accessToken: string,
  accountId: string,
  bucketName: string,
  jurisdiction?: string,
): Promise<boolean> {
  const headers = jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : undefined;
  const get = await cloudflareRaw(accessToken, `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}`, {
    headers,
  });
  if (get.status === 200) {
    await parseCloudflareEnvelope(get, `Get R2 bucket ${bucketName}`);
    return false;
  }
  if (get.status !== 404) await parseCloudflareEnvelope(get, `Get R2 bucket ${bucketName}`);

  const create = await cloudflareRaw(accessToken, `/accounts/${accountId}/r2/buckets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: bucketName }),
  });
  await parseCloudflareEnvelope(create, `Create R2 bucket ${bucketName}`);
  return true;
}

async function ensureKvNamespace(
  accessToken: string,
  accountId: string,
  title: string,
): Promise<string> {
  const existing = await cloudflareApi<unknown>(
    accessToken,
    `/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
    {},
    "List KV namespaces",
  );
  const namespaces = decodeList<{ id: string; title: string }>(existing, ["items"]);
  const found = namespaces.find((namespace) => namespace.title === title);
  if (found) return found.id;

  const created = await cloudflareApi<{ id: string }>(
    accessToken,
    `/accounts/${accountId}/storage/kv/namespaces`,
    { method: "POST", body: JSON.stringify({ title }) },
    `Create KV namespace ${title}`,
  );
  return created.id;
}

async function fetchAccountWorkersSubdomain(
  accessToken: string,
  accountId: string,
  logger: DeployLogger,
): Promise<string | null> {
  try {
    const result = await cloudflareApi<{ subdomain?: string }>(
      accessToken,
      `/accounts/${accountId}/workers/subdomain`,
      {},
      "Get workers.dev subdomain",
    );
    return result.subdomain || null;
  } catch (error) {
    await logger.warning(`Could not fetch workers.dev subdomain: ${error instanceof Error ? error.message : String(error)}.`);
    return null;
  }
}

async function enableWorkersDev(
  accessToken: string,
  accountId: string,
  scriptName: string,
  logger: DeployLogger,
): Promise<void> {
  try {
    await cloudflareApi(
      accessToken,
      `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
      {
        method: "POST",
        headers: { "Cloudflare-Workers-Script-Api-Date": WORKERS_SUBDOMAIN_API_DATE },
        body: JSON.stringify({ enabled: true, previews_enabled: true }),
      },
      `Enable workers.dev for ${scriptName}`,
    );
    await logger.info(`workers.dev enabled for ${scriptName}.`);
  } catch (error) {
    await logger.warning(`Failed to enable workers.dev for ${scriptName}: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

type MetadataOptions = {
  instance: DeployInstance;
  selectedComponents: Set<string>;
  availableScripts: Set<string>;
  accountSubdomain: string | null;
  existingMigrationTag: string | null;
  includeMigrations: boolean;
  scriptExists: boolean;
  uploadedAssets: UploadedAssets | null;
  keepAssets: boolean;
  logger: DeployLogger;
};

async function buildUploadMetadata(
  accessToken: string,
  accountId: string,
  bundle: PreparedBundle,
  options: MetadataOptions,
): Promise<Record<string, unknown>> {
  const compatibilityDate = bundle.wrangler.compatibility_date;
  if (!compatibilityDate) throw new Error(`${bundle.scriptName} is missing compatibility_date.`);

  const bindings: unknown[] = [];
  for (const binding of bundle.wrangler.durable_objects?.bindings ?? []) {
    const value: Record<string, unknown> = {
      name: binding.name,
      type: "durable_object_namespace",
      class_name: binding.class_name,
    };
    if (binding.script_name) value.script_name = scriptNameForConfigService(options.instance, binding.script_name);
    if (binding.environment) value.environment = binding.environment;
    bindings.push(value);
  }

  for (const kv of bundle.wrangler.kv_namespaces ?? []) {
    const title = `${bundle.scriptName}-${kv.binding}`;
    const namespaceId = kv.id || (await ensureKvNamespace(accessToken, accountId, title));
    bindings.push({
      name: kv.binding,
      type: "kv_namespace",
      namespace_id: namespaceId,
    });
    if (!kv.id) await options.logger.info(`KV namespace ${title} ready.`);
  }

  for (const r2 of bundle.wrangler.r2_buckets ?? []) {
    if (!r2.bucket_name) throw new Error(`${bundle.scriptName} has R2 binding ${r2.binding} without bucket_name.`);
    const value: Record<string, unknown> = {
      name: r2.binding,
      type: "r2_bucket",
      bucket_name: r2.bucket_name,
    };
    if (r2.jurisdiction) value.jurisdiction = r2.jurisdiction;
    bindings.push(value);
  }

  for (const service of serviceBindingsForBundle(bundle, options)) {
    const value: Record<string, unknown> = {
      name: service.binding,
      type: "service",
      service: service.service,
    };
    if (service.environment) value.environment = service.environment;
    if (service.entrypoint) value.entrypoint = service.entrypoint;
    bindings.push(value);
  }

  for (const loader of bundle.wrangler.worker_loaders ?? []) {
    bindings.push({ name: loader.binding, type: "worker_loader" });
  }

  if (bundle.wrangler.ai) {
    const value: Record<string, unknown> = {
      name: bundle.wrangler.ai.binding,
      type: "ai",
    };
    if (typeof bundle.wrangler.ai.staging === "boolean") value.staging = bundle.wrangler.ai.staging;
    bindings.push(value);
  }

  if (bundle.component === COMPONENT_CHANNEL_TELEGRAM && options.accountSubdomain) {
    bindings.push({
      name: "TELEGRAM_WEBHOOK_BASE_URL",
      type: "plain_text",
      text: workersDevUrl(bundle.scriptName, options.accountSubdomain),
    });
  }

  if (bundle.wrangler.assets?.binding) {
    bindings.push({ name: bundle.wrangler.assets.binding, type: "assets" });
  }

  const metadata: Record<string, unknown> = {
    main_module: bundle.entrypointPartName,
    bindings,
    compatibility_date: compatibilityDate,
  };

  if (bundle.wrangler.compatibility_flags?.length) {
    metadata.compatibility_flags = bundle.wrangler.compatibility_flags;
  }
  if (options.includeMigrations) {
    const migrations = buildMigrationsPayload(bundle.wrangler.migrations ?? [], options.existingMigrationTag);
    if (migrations) metadata.migrations = migrations;
    else if (!options.scriptExists) {
      const inferred = buildInferredDoMigration(bundle.wrangler);
      if (inferred) metadata.migrations = inferred;
    }
  }
  if (bundle.wrangler.observability) metadata.observability = bundle.wrangler.observability;
  if (options.uploadedAssets) {
    metadata.assets = { jwt: options.uploadedAssets.jwt, config: options.uploadedAssets.config };
  }
  if (options.keepAssets) metadata.keep_assets = true;

  return metadata;
}

function serviceBindingsForBundle(
  bundle: PreparedBundle,
  options: Pick<MetadataOptions, "instance" | "selectedComponents" | "availableScripts">,
): Array<{ binding: string; service: string; environment?: string; entrypoint?: string }> {
  const bindings = [...(bundle.wrangler.services ?? [])];
  const gatewayScriptName = scriptNameForComponent(options.instance, COMPONENT_GATEWAY);
  const telegramScriptName = scriptNameForComponent(options.instance, COMPONENT_CHANNEL_TELEGRAM);

  if (
    bundle.component === COMPONENT_CHANNEL_WHATSAPP &&
    !bindings.some((binding) => binding.binding === "GATEWAY") &&
    (options.selectedComponents.has(COMPONENT_GATEWAY) || options.availableScripts.has(gatewayScriptName))
  ) {
    bindings.push({ binding: "GATEWAY", service: gatewayScriptName, entrypoint: "GatewayEntrypoint" });
  }

  if (
    bundle.component === COMPONENT_GATEWAY &&
    !bindings.some((binding) => binding.binding === "CHANNEL_TELEGRAM") &&
    (options.selectedComponents.has(COMPONENT_CHANNEL_TELEGRAM) || options.availableScripts.has(telegramScriptName))
  ) {
    bindings.push({ binding: "CHANNEL_TELEGRAM", service: telegramScriptName, entrypoint: "TelegramChannel" });
  }

  const out: Array<{ binding: string; service: string; environment?: string; entrypoint?: string }> = [];
  for (const raw of bindings) {
    const binding = { ...raw };
    if (
      bundle.component === COMPONENT_GATEWAY &&
      binding.binding === "CHANNEL_WHATSAPP" &&
      binding.entrypoint === "WhatsAppChannel"
    ) {
      binding.entrypoint = "WhatsAppChannelEntrypoint";
    }
    binding.service = scriptNameForConfigService(options.instance, binding.service);
    if (options.availableScripts.has(binding.service)) out.push(binding);
  }
  return out;
}

function buildMigrationsPayload(configMigrations: unknown[], currentTag: string | null): unknown | null {
  if (configMigrations.length === 0) return null;
  const newTag = migrationTag(configMigrations.at(-1));
  if (!newTag) return null;
  const allSteps = configMigrations.map(migrationStepWithoutTag).filter(Boolean);
  if (allSteps.length === 0) return null;

  if (currentTag) {
    const index = configMigrations.findIndex((step) => migrationTag(step) === currentTag);
    if (index === configMigrations.length - 1) return null;
    const steps = index >= 0 ? configMigrations.slice(index + 1).map(migrationStepWithoutTag).filter(Boolean) : allSteps;
    if (steps.length === 0) return null;
    return { old_tag: currentTag, new_tag: newTag, steps };
  }

  return { new_tag: newTag, steps: allSteps };
}

function buildInferredDoMigration(config: WranglerConfig): unknown | null {
  const classes = (config.durable_objects?.bindings ?? [])
    .map((binding) => binding.class_name)
    .filter(Boolean)
    .sort();
  const unique = [...new Set(classes)];
  if (unique.length === 0) return null;
  return { new_tag: "auto-v1", steps: [{ new_sqlite_classes: unique }] };
}

function migrationTag(step: unknown): string | null {
  return isRecord(step) && typeof step.tag === "string" ? step.tag : null;
}

function migrationStepWithoutTag(step: unknown): unknown | null {
  if (!isRecord(step)) return null;
  const copy = { ...step };
  delete copy.tag;
  return copy;
}

async function syncAssetsForBundle(
  accessToken: string,
  accountId: string,
  bundle: PreparedBundle,
  logger: DeployLogger,
): Promise<UploadedAssets | null> {
  if (!hasAssets(bundle)) return null;
  const assetsDir = normalizePath(bundle.manifest.assetsDir ?? bundle.manifest.assets_dir ?? "");
  const binding = bundle.wrangler.assets?.binding;
  if (!binding) throw new Error(`${bundle.component} bundle includes assets but wrangler assets.binding is missing.`);

  const files = await collectAssetFiles(bundle.files, assetsDir);
  await logger.info(`Syncing static assets for ${bundle.scriptName} (${files.length} files).`);

  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const file of files) manifest[file.relativePath] = { hash: file.hash, size: file.bytes.byteLength };

  const session = await cloudflareApi<AssetsUploadSessionResponse>(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${bundle.scriptName}/assets-upload-session`,
    { method: "POST", body: JSON.stringify({ manifest }) },
    `Start assets upload for ${bundle.scriptName}`,
  );

  let completionJwt = session.jwt;
  const buckets = session.buckets ?? [];
  if (buckets.length > 0) {
    if (!session.jwt) throw new Error(`Assets upload session for ${bundle.scriptName} did not return an upload jwt.`);
    const byHash = new Map(files.map((file) => [file.hash, file]));
    const uploadUrl = cloudflareApiUrl(`/accounts/${accountId}/workers/assets/upload`);
    for (const bucket of buckets) {
      const form = new FormData();
      for (const hash of bucket) {
        const file = byHash.get(hash);
        if (!file) throw new Error(`Cloudflare requested unknown asset hash ${hash}.`);
        form.append(hash, new Blob([base64(file.bytes)], { type: file.contentType }), hash);
      }
      const response = await fetch(`${uploadUrl}?base64=true`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.jwt}` },
        body: form,
      });
      const result = await parseCloudflareEnvelope<AssetsUploadBucketResponse>(response, "Upload assets bucket");
      completionJwt = result.jwt ?? completionJwt;
    }
  }
  if (!completionJwt) throw new Error(`Assets upload for ${bundle.scriptName} did not return a completion jwt.`);

  return { jwt: completionJwt, config: buildAssetsMetadataConfig(bundle, assetsDir) };
}

function hasAssets(bundle: PreparedBundle): boolean {
  return Boolean(bundle.manifest.assetsDir ?? bundle.manifest.assets_dir);
}

async function collectAssetFiles(files: Map<string, Uint8Array>, assetsDir: string): Promise<
  Array<{ relativePath: string; bytes: Uint8Array; hash: string; contentType: string }>
> {
  const prefix = assetsDir.endsWith("/") ? assetsDir : `${assetsDir}/`;
  const out: Array<{ relativePath: string; bytes: Uint8Array; hash: string; contentType: string }> = [];
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix) || isSkippablePath(path)) continue;
    const relative = `/${path.slice(prefix.length)}`;
    out.push({
      relativePath: relative,
      bytes,
      hash: buildAssetHash(path, bytes),
      contentType: contentTypeForPath(path),
    });
  }
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function buildAssetHash(path: string, bytes: Uint8Array): string {
  const hashInput = `${base64(bytes)}${extension(path)}`;
  return hex(blake3(new TextEncoder().encode(hashInput))).slice(0, 32);
}

function buildAssetsMetadataConfig(bundle: PreparedBundle, assetsDir: string): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (bundle.wrangler.assets?.html_handling) config.html_handling = bundle.wrangler.assets.html_handling;
  if (bundle.wrangler.assets?.not_found_handling) config.not_found_handling = bundle.wrangler.assets.not_found_handling;
  if (bundle.wrangler.assets?.run_worker_first) config.run_worker_first = bundle.wrangler.assets.run_worker_first;

  const redirects = bundle.files.get(`${assetsDir}/_redirects`);
  if (redirects) config._redirects = decodeText(redirects);
  const headers = bundle.files.get(`${assetsDir}/_headers`);
  if (headers) config._headers = decodeText(headers);
  return config;
}

async function uploadWorkerScript(
  accessToken: string,
  accountId: string,
  bundle: PreparedBundle,
  metadata: Record<string, unknown>,
  keepExistingAssets: boolean,
): Promise<void> {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    bundle.entrypointPartName,
    new Blob([bundle.entrypointBytes], { type: "application/javascript+module" }),
    bundle.entrypointPartName,
  );
  for (const module of bundle.additionalModules) {
    form.append(module.partName, new Blob([module.bytes], { type: module.mimeType }), module.partName);
  }
  if (bundle.sourceMap) {
    form.append(bundle.sourceMap.name, new Blob([bundle.sourceMap.bytes], { type: "application/source-map" }), bundle.sourceMap.name);
  }

  const response = await fetch(
    cloudflareApiUrl(`/accounts/${accountId}/workers/scripts/${bundle.scriptName}?excludeScript=true`),
    { method: "PUT", headers: { Authorization: `Bearer ${accessToken}` }, body: form },
  );
  await parseCloudflareEnvelope(response, `Upload script ${bundle.scriptName}${keepExistingAssets ? " bindings" : ""}`);
}

async function setWorkerSecret(
  accessToken: string,
  accountId: string,
  scriptName: string,
  secretName: string,
  secretValue: string,
): Promise<void> {
  await cloudflareApi(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
    {
      method: "PUT",
      body: JSON.stringify({ name: secretName, text: secretValue, type: "secret_text" }),
    },
    `Set worker secret ${secretName}`,
  );
}

async function cloudflareApi<T>(
  accessToken: string,
  path: string,
  init: RequestInit,
  context: string,
): Promise<T> {
  const response = await cloudflareRaw(accessToken, path, init);
  return parseCloudflareEnvelope<T>(response, context);
}

async function cloudflareRaw(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type") && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  return fetch(cloudflareApiUrl(path), { ...init, headers });
}

function cloudflareApiUrl(path: string): string {
  return `https://api.cloudflare.com/client/v4${path}`;
}

async function parseCloudflareEnvelope<T = unknown>(response: Response, context: string): Promise<T> {
  const body = await response.text();
  let envelope: CloudflareApiResponse<T> | null = null;
  try {
    envelope = JSON.parse(body) as CloudflareApiResponse<T>;
  } catch {
    if (!response.ok) throw new Error(`${context} failed (${response.status}): ${body.slice(0, 500)}`);
    throw new Error(`${context} returned invalid JSON.`);
  }

  if (!response.ok || !envelope.success) {
    throw new Error(`${context} failed (${response.status}): ${summarizeCloudflareMessages(envelope)}`);
  }
  return envelope.result;
}

function summarizeCloudflareMessages(envelope: Pick<CloudflareApiResponse<unknown>, "errors" | "messages">): string {
  const parts = [...(envelope.errors ?? []), ...(envelope.messages ?? [])].map((message) =>
    message.code ? `${message.message} (${message.code})` : message.message,
  );
  return parts.length > 0 ? parts.join("; ") : "Unknown Cloudflare API error";
}

function decodeList<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isRecord(value)) {
    for (const key of keys) {
      const candidate = value[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  throw new Error("Cloudflare API list shape is unexpected.");
}

function parseTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  for (let offset = 0; offset + 512 <= bytes.byteLength; ) {
    const header = bytes.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const rawName = readTarString(header, 0, 100);
    const rawPrefix = readTarString(header, 345, 155);
    const path = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    const size = parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0);
    offset += 512;

    const content = bytes.slice(offset, offset + size);
    if ((type === "0" || type === "\0" || type === "") && path) {
      entries.push({ path, bytes: content });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(header: Uint8Array, offset: number, length: number): string {
  const slice = header.slice(offset, offset + length);
  const zero = slice.indexOf(0);
  return decodeText(zero >= 0 ? slice.slice(0, zero) : slice).trim();
}

function readJson<T>(files: Map<string, Uint8Array>, path: string): T {
  return JSON.parse(readText(files, path)) as T;
}

function readText(files: Map<string, Uint8Array>, path: string): string {
  return decodeText(readFile(files, normalizePath(path)));
}

function readFile(files: Map<string, Uint8Array>, path: string): Uint8Array {
  const file = files.get(normalizePath(path));
  if (!file) throw new Error(`Bundle file missing: ${path}`);
  return file;
}

async function fetchBytes(url: string, context: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { "User-Agent": "gsv-deployment" } });
  if (!response.ok) throw new Error(`${context} failed (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

async function parseJsonResponse(response: Response, context: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${context} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function workersDevDomain(subdomain: string): string {
  const trimmed = subdomain.trim().replace(/\.$/, "");
  return trimmed.endsWith(".workers.dev") ? trimmed : `${trimmed}.workers.dev`;
}

function workersDevUrl(scriptName: string, subdomain: string): string {
  return `https://${scriptName}.${workersDevDomain(subdomain)}`;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function dirname(path: string): string {
  const index = normalizePath(path).lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

function isSkippablePath(path: string): boolean {
  return normalizePath(path)
    .split("/")
    .some((part) => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"));
}

function contentTypeForPath(path: string): string {
  switch (extension(path)) {
    case "html":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "wasm":
      return "application/wasm";
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
