import { blake3 } from "@noble/hashes/blake3.js";
import type { WorkflowStep } from "cloudflare:workers";
import { parse as parseJsonc } from "jsonc-parser";
import { ungzip } from "pako";
import { parse as parseToml } from "smol-toml";

import { getDeployHelp } from "./deploy-help";
import { deleteDeployCredentials, DeployJobWriter, getDeployCredentials } from "./jobs";
import { trackEvent } from "./metrics";
import {
  DEPLOYMENT_MANIFEST_FILE,
  legacyTopologyFromChecksums,
  parseGsvReleaseManifest,
  topologyFromManifest,
} from "./release-manifest";
import type {
  ReleaseAdapter,
  ReleaseComponent,
  ReleaseTopology,
} from "./release-manifest";
import type {
  Account,
  AppEnv,
  DeployOptions,
  DeployStepId,
  DeployStepStatus,
} from "./types";

const COMPONENT_GATEWAY = "gateway";
const COMPONENT_RIPGIT = "ripgit";
const LEGACY_COMPONENT_ASSEMBLER = "assembler";

const BUNDLE_CHECKSUMS = "cloudflare-checksums.txt";
const DEFAULT_DEPLOY_INSTANCE = "gsv";
const DEFAULT_STORAGE_BUCKET_NAME = "gsv-storage";
const SCRIPT_GATEWAY = "gsv";
const SCRIPT_RIPGIT = "ripgit";
const LEGACY_SCRIPT_ASSEMBLER = "gsv-assembler";
const RIPGIT_PAID_CPU_LIMIT_MS = 300_000;
const WORKER_TAG_MANAGED = "gsv-managed-v1";
const WORKER_TAG_INSTANCE_PREFIX = "gsv-instance-";
const WORKER_TAG_COMPONENT_PREFIX = "gsv-component-";
const WORKERS_SUBDOMAIN_API_DATE = "2025-08-01";
const MAX_SOURCE_MAP_UPLOAD_BYTES = 2 * 1024 * 1024;
const R2_DELETE_BATCH_SIZE = 32;
const R2_DELETE_CONCURRENCY = 6;
const DEPLOY_WORKFLOW_STEP_CONFIG = {
  timeout: "30 minutes",
  retries: { limit: 2, delay: "30 seconds", backoff: "linear" },
} as const;
const SENSITIVE_DEPLOY_WORKFLOW_STEP_CONFIG = {
  ...DEPLOY_WORKFLOW_STEP_CONFIG,
  sensitive: "output",
} as const;
const CLEANUP_WORKFLOW_STEP_CONFIG = {
  timeout: "2 minutes",
  retries: { limit: 3, delay: "10 seconds", backoff: "linear" },
} as const;

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
  deleteSupported: boolean;
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
    props?: {
      id: string;
      calls: string[];
    };
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
  limits?: {
    cpu_ms?: number;
    subrequests?: number;
  };
};

type PreparedBundle = {
  component: string;
  adapter?: ReleaseAdapter;
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
  tags?: string[] | null;
};

type WorkerScriptDetails = {
  migrationTag: string | null;
  tags: string[];
};

type WorkersAccountSettings = {
  default_usage_model?: string;
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
  adapters: ReleaseAdapter[];
  artifactCachePrefix: string;
};

type DeploymentPreflight = {
  accountSubdomain: string | null;
  workersPaid: boolean;
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

type PreparedRelease = {
  bundles: PreparedBundle[];
  topology: ReleaseTopology;
};

type ReleaseArtifactSource =
  | { kind: "release"; snapshotPrefix: string }
  | { kind: "snapshot"; snapshotPrefix: string };

type FetchedReleaseAsset = {
  fileName: string;
  bytes: Uint8Array;
  cacheKey?: string;
};

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
      installations.push(
        ...detectGsvInstallations(
          account,
          [...scripts].map(([id, details]) => ({ id, tags: details.tags })),
        ),
      );
    } catch {
      // Account inspection is opportunistic. The deploy form should still render.
    }
  }
  return installations.sort((a, b) => {
    const account = a.accountName.localeCompare(b.accountName);
    return account || a.instance.localeCompare(b.instance);
  });
}

export type DeleteWorkersResult = {
  deleted: string[];
  failed: Array<{ script: string; error: string }>;
};

export type DeleteR2ObjectsBatchResult = {
  bucketMissing: boolean;
  deleted: number;
  empty: boolean;
};

export function storageBucketNameForInstance(instance: string): string {
  return instance === DEFAULT_DEPLOY_INSTANCE ? DEFAULT_STORAGE_BUCKET_NAME : `${instance}-storage`;
}

/**
 * Removes the Worker scripts that make up a verified GSV install. `force=true`
 * is intentional: deleting a GSV also deletes the Durable Object namespaces and
 * runtime data owned by those scripts. R2 cleanup happens only after this phase
 * succeeds, so a partial Worker failure cannot erase the installation's files.
 */
export async function deleteGsvWorkers(
  accessToken: string,
  installation: ExistingGsvInstallation,
): Promise<DeleteWorkersResult> {
  if (!installation.deleteSupported) {
    return refusedDeletionResult(
      installation,
      "Worker ownership could not be verified from GSV management tags.",
    );
  }

  let currentScripts: Map<string, WorkerScriptDetails>;
  try {
    currentScripts = await listWorkerScripts(accessToken, installation.accountId);
  } catch (error) {
    return refusedDeletionResult(
      installation,
      `Worker ownership could not be reverified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const unsafeScripts = installation.scriptNames.filter((scriptName) => {
    const details = currentScripts.get(scriptName);
    if (!details) return false;
    const component = componentForInstallationScriptName(installation.instance, scriptName);
    return !component || !hasExpectedWorkerTags(details.tags, installation.instance, component);
  });
  if (unsafeScripts.length > 0) {
    return {
      deleted: [],
      failed: unsafeScripts.map((script) => ({
        script,
        error: "Worker ownership changed or could not be verified from GSV management tags.",
      })),
    };
  }

  const deleted: string[] = [];
  const failed: Array<{ script: string; error: string }> = [];
  // Delete the gateway (and other dependents) before their dependencies.
  const ordered = [...installation.scriptNames].sort((a, b) => deleteOrder(b) - deleteOrder(a));
  for (const scriptName of ordered) {
    try {
      await deleteWorkerScript(accessToken, installation.accountId, scriptName);
      deleted.push(scriptName);
    } catch (error) {
      failed.push({ script: scriptName, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { deleted, failed };
}

function refusedDeletionResult(
  installation: ExistingGsvInstallation,
  error: string,
): DeleteWorkersResult {
  const scripts = installation.scriptNames.length > 0 ? installation.scriptNames : [installation.instance];
  return {
    deleted: [],
    failed: scripts.map((script) => ({ script, error })),
  };
}

export async function deleteR2ObjectsBatch(
  accessToken: string,
  accountId: string,
  bucketName: string,
): Promise<DeleteR2ObjectsBatchResult> {
  const response = await cloudflareRaw(
    accessToken,
    `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects?per_page=${R2_DELETE_BATCH_SIZE}`,
  );
  if (response.status === 404) return { bucketMissing: true, deleted: 0, empty: true };

  const objects = await parseCloudflareEnvelope<Array<{ key?: string }>>(response, `List R2 objects in ${bucketName}`);
  const keys = objects.map((object) => object.key);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error(`List R2 objects in ${bucketName} returned an object without a key.`);
  }
  const objectKeys = keys as string[];
  for (let index = 0; index < objectKeys.length; index += R2_DELETE_CONCURRENCY) {
    await Promise.all(
      objectKeys
        .slice(index, index + R2_DELETE_CONCURRENCY)
        .map((key) => deleteR2Object(accessToken, accountId, bucketName, key)),
    );
  }
  return { bucketMissing: false, deleted: objectKeys.length, empty: objectKeys.length === 0 };
}

export async function deleteR2Bucket(accessToken: string, accountId: string, bucketName: string): Promise<void> {
  const response = await cloudflareRaw(
    accessToken,
    `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}`,
    { method: "DELETE" },
  );
  // A bucket that is already gone is a success from the caller's perspective.
  if (response.status === 404) return;
  await parseCloudflareEnvelope(response, `Delete R2 bucket ${bucketName}`);
}

async function deleteR2Object(
  accessToken: string,
  accountId: string,
  bucketName: string,
  objectKey: string,
): Promise<void> {
  const response = await cloudflareRaw(
    accessToken,
    `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeR2ObjectKey(objectKey)}`,
    { method: "DELETE" },
  );
  if (response.status === 404) return;
  await parseCloudflareEnvelope(response, `Delete R2 object from ${bucketName}`);
}

function encodeR2ObjectKey(key: string): string {
  // Cloudflare's R2 REST API requires path separators in object keys to stay
  // literal while all other reserved characters remain percent-encoded.
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

async function deleteWorkerScript(accessToken: string, accountId: string, scriptName: string): Promise<void> {
  const response = await cloudflareRaw(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}?force=true`,
    { method: "DELETE" },
  );
  // A script that is already gone is a success from the caller's perspective.
  if (response.status === 404) return;
  await parseCloudflareEnvelope(response, `Delete script ${scriptName}`);
}

function deleteOrder(scriptName: string): number {
  const match = componentForScriptName(scriptName);
  return match ? deployOrder(match.component) : 100;
}

export async function runDeployWorkflow(
  env: AppEnv["Bindings"],
  jobId: string,
  step: WorkflowStep,
): Promise<void> {
  try {
    const deploymentPlan = await step.do("prepare deployment", DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, async ({ writer, logger }) => {
        await writer.update({ status: "running" }, { flush: false });
        return prepareDeploymentPlan(env, jobId, writer.job.options, logger);
      }),
    );

    const preflight = await step.do("inspect target and ensure storage", SENSITIVE_DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, ({ accessToken, writer, logger }) =>
        inspectDeploymentTarget(env, accessToken, writer.job.options.accountId, deploymentPlan, logger),
      ),
    );

    await step.do("deploy worker scripts", DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, async ({ accessToken, writer, logger }) => {
        await deployWorkerScripts(env, accessToken, writer.job.options.accountId, deploymentPlan, preflight, logger);
        return { ok: true };
      }),
    );

    await step.do("finalize worker bindings", DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, async ({ accessToken, writer, logger }) => {
        await finalizeWorkerBindings(env, accessToken, writer.job.options.accountId, deploymentPlan, preflight, logger);
        return { ok: true };
      }),
    );

    await step.do("configure adapters and finish", DEPLOY_WORKFLOW_STEP_CONFIG, async () =>
      withDeploymentPhase(env, jobId, async ({ writer, logger }) => {
        const result = await configureAdaptersAndFinish(
          deploymentPlan,
          preflight,
          logger,
        );
        await recordDeploymentSuccess(env, writer, result);
        return result;
      }),
    );
  } catch (error) {
    try {
      await step.do("record deployment failure", CLEANUP_WORKFLOW_STEP_CONFIG, async () => {
        await recordDeploymentFailure(env, jobId, error);
        return { ok: true };
      });
    } catch (recordError) {
      logWorkflowMaintenanceError(jobId, "record deployment failure", recordError);
    }
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  } finally {
    try {
      await step.do("cleanup deployment credentials", CLEANUP_WORKFLOW_STEP_CONFIG, async () => {
        await deleteDeployCredentials(env, jobId);
        return { ok: true };
      });
    } catch (error) {
      logWorkflowMaintenanceError(jobId, "cleanup deployment credentials", error);
    }

    try {
      await step.do("cleanup deployment artifacts", CLEANUP_WORKFLOW_STEP_CONFIG, async () => {
        await cleanupDeploymentArtifactPrefix(env, deploymentArtifactCachePrefix(jobId), SILENT_LOGGER, true);
        return { ok: true };
      });
    } catch (error) {
      logWorkflowMaintenanceError(jobId, "cleanup deployment artifacts", error);
    }
  }
}

async function withDeploymentPhase<T>(
  env: AppEnv["Bindings"],
  jobId: string,
  callback: (phase: DeploymentPhase) => Promise<T>,
): Promise<T> {
  const phase = await loadDeploymentPhase(env, jobId);
  try {
    return await callback(phase);
  } finally {
    await phase.writer.flush();
  }
}

async function loadDeploymentPhase(env: AppEnv["Bindings"], jobId: string): Promise<DeploymentPhase> {
  const writer = await DeployJobWriter.load(env, jobId);
  if (!writer) throw new Error(`Deployment job ${jobId} was not found.`);

  const credentials = await getDeployCredentials(env, jobId);
  if (!credentials) throw new Error("Deployment credentials expired. Please authorize Cloudflare again.");

  return {
    accessToken: credentials.accessToken,
    writer,
    logger: new DeployLogger(writer),
  };
}

function logWorkflowMaintenanceError(jobId: string, operation: string, error: unknown): void {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    jobId,
    message: `Workflow maintenance step failed: ${operation}`,
  }));
}

async function prepareDeploymentPlan(
  env: AppEnv["Bindings"],
  jobId: string,
  options: DeployOptions,
  logger: DeployLogger,
): Promise<DeploymentPlan> {
  const instance = parseInstance(options.instance);

  const repoOwner = env.GSV_REPO_OWNER || "deathbyknowledge";
  const repoName = env.GSV_REPO_NAME || "gsv";
  await logger.step("release", "running", "Looking up the requested GSV release.");
  const version = await resolveReleaseTag(repoOwner, repoName, options.version, logger);
  await logger.step("release", "complete", `Using ${version}.`);
  await logger.info(`Preparing the complete GSV stack from ${version}.`);

  await logger.step("prepare", "running", "Downloading and verifying the selected GSV release.");
  const artifactCachePrefix = deploymentArtifactCachePrefix(jobId);
  const prepared = await prepareBundles(env, repoOwner, repoName, version, instance, logger, {
    kind: "release",
    snapshotPrefix: artifactCachePrefix,
  });
  const components = prepared.bundles.map((bundle) => bundle.component);
  if (components.length === 0) {
    throw new Error(`The GSV release ${version} contains no deployable components.`);
  }
  await logger.step("prepare", "complete", "The GSV release is verified and ready.");

  return {
    repoOwner,
    repoName,
    version,
    instance,
    components,
    adapters: prepared.topology.manifest?.adapters ?? [],
    artifactCachePrefix,
  };
}

async function inspectDeploymentTarget(
  env: AppEnv["Bindings"],
  accessToken: string,
  accountId: string,
  plan: DeploymentPlan,
  logger: DeployLogger,
): Promise<DeploymentPreflight> {
  const selectedComponents = new Set(plan.components);
  const [existingScriptsWithMigrations, workersPaid] = await Promise.all([
    listWorkerScripts(accessToken, accountId),
    resolveWorkersPaid(accessToken, accountId, logger),
  ]);
  const existingScripts = new Set([...existingScriptsWithMigrations.keys()]);
  assertGatewayDependenciesAvailable(
    selectedComponents,
    selectedOrExistingScripts(selectedComponents, existingScripts, plan.instance),
    plan.instance,
  );

  await logger.step("storage", "running", "Checking Cloudflare storage resources.");
  const prepared = await prepareBundlesForPhase(env, plan, logger, "Loading verified bundles for storage checks.");
  await ensureStorageResources(accessToken, accountId, prepared, logger);
  await logger.step("storage", "complete", "Storage resources are ready.");

  const accountSubdomain = await fetchAccountWorkersSubdomain(accessToken, accountId, logger);
  return { accountSubdomain, workersPaid };
}

async function deployWorkerScripts(
  env: AppEnv["Bindings"],
  accessToken: string,
  accountId: string,
  plan: DeploymentPlan,
  preflight: DeploymentPreflight,
  logger: DeployLogger,
): Promise<void> {
  const prepared = await prepareBundlesForPhase(env, plan, logger, "Loading verified bundles for Worker upload.");
  const selectedComponents = new Set(plan.components);
  const existingScriptsWithMigrations = await listWorkerScripts(accessToken, accountId);
  const accountSubdomain = preflight.accountSubdomain;
  assertGatewayDependenciesAvailable(
    selectedComponents,
    selectedOrExistingScripts(selectedComponents, new Set(existingScriptsWithMigrations.keys()), plan.instance),
    plan.instance,
  );
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
      adapters: plan.adapters,
      accountSubdomain,
      existingMigrationTag: existingScriptsWithMigrations.get(bundle.scriptName)?.migrationTag ?? null,
      includeMigrations: true,
      scriptExists: existingScriptsWithMigrations.has(bundle.scriptName),
      uploadedAssets,
      keepAssets: false,
      workersPaid: preflight.workersPaid,
      logger,
    });
    await uploadWorkerScript(accessToken, accountId, bundle, metadata, false);
    await logger.info(`Uploaded ${bundle.scriptName}.`);
    availableScripts.add(bundle.scriptName);
    await enableWorkersDev(accessToken, accountId, bundle.scriptName, logger);
  }
  await logger.step("workers", "complete", "Workers and assets are deployed.");
}

async function finalizeWorkerBindings(
  env: AppEnv["Bindings"],
  accessToken: string,
  accountId: string,
  plan: DeploymentPlan,
  preflight: DeploymentPreflight,
  logger: DeployLogger,
): Promise<void> {
  const prepared = await prepareBundlesForPhase(env, plan, logger, "Loading verified bundles for binding finalization.");
  const selectedComponents = new Set(plan.components);
  const currentScriptsWithMigrations = await listWorkerScripts(accessToken, accountId);
  const availableScripts = new Set(currentScriptsWithMigrations.keys());
  for (const component of selectedComponents) {
    availableScripts.add(scriptNameForComponent(plan.instance, component));
  }
  assertGatewayDependenciesAvailable(selectedComponents, availableScripts, plan.instance);
  const accountSubdomain = preflight.accountSubdomain;

  await logger.step("bindings", "running", "Connecting GSV services.");
  await logger.info("Finalizing service bindings (pass 2/2).");
  for (const bundle of prepared) {
    await logger.info(`Finalizing ${bundle.component} (${bundle.scriptName}).`);
    const metadata = await buildUploadMetadata(accessToken, accountId, bundle, {
      instance: plan.instance,
      selectedComponents,
      availableScripts,
      adapters: plan.adapters,
      accountSubdomain,
      existingMigrationTag: null,
      includeMigrations: false,
      scriptExists: true,
      uploadedAssets: null,
      keepAssets: hasAssets(bundle),
      workersPaid: preflight.workersPaid,
      logger,
    });
    await uploadWorkerScript(accessToken, accountId, bundle, metadata, true);
    await logger.info(`Updated bindings for ${bundle.scriptName}.`);
  }
  await logger.step("bindings", "complete", "GSV services are connected.");
}

async function configureAdaptersAndFinish(
  plan: DeploymentPlan,
  preflight: DeploymentPreflight,
  logger: DeployLogger,
): Promise<DeploymentResult> {
  const selectedComponents = new Set(plan.components);
  const accountSubdomain = preflight.accountSubdomain;
  const gatewayScriptName = scriptNameForComponent(plan.instance, COMPONENT_GATEWAY);

  const hasChannelComponents = [...selectedComponents].some((component) => component.startsWith("channel-"));
  if (hasChannelComponents) {
    await logger.step("adapters", "running", "Confirming adapter deployment.");
    const outcome = adapterConfigurationOutcome(
      plan.adapters,
      [...selectedComponents],
      accountSubdomain,
    );
    await logger.step(
      "adapters",
      outcome.status,
      outcome.detail,
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
        : "GSV services are deployed.",
  );

  return { version: plan.version, gatewayUrl };
}

export function adapterConfigurationOutcome(
  adapters: readonly ReleaseAdapter[],
  selectedComponents: readonly string[],
  accountSubdomain: string | null,
): { status: "complete" | "warning"; detail: string } {
  const detail = "Messaging adapters are installed and can be connected later in GSV.";
  const needsPublicUrl = adapters.some(
    (adapter) => adapter.standalone.selfUrlBinding !== undefined,
  ) || (
    adapters.length === 0 && selectedComponents.includes("channel-telegram")
  );
  if (needsPublicUrl && !accountSubdomain) {
    return {
      status: "warning",
      detail: `${detail} A webhook URL could not be configured because the workers.dev subdomain was unavailable.`,
    };
  }
  return { status: "complete", detail };
}

async function prepareBundlesForPhase(
  env: AppEnv["Bindings"],
  plan: DeploymentPlan,
  logger: DeployLogger,
  message: string,
): Promise<PreparedBundle[]> {
  await logger.info(message);
  const prepared = await prepareBundles(
    env,
    plan.repoOwner,
    plan.repoName,
    plan.version,
    plan.instance,
    SILENT_LOGGER,
    {
      kind: "snapshot",
      snapshotPrefix: plan.artifactCachePrefix,
    },
  );
  return prepared.bundles;
}

async function recordDeploymentSuccess(
  env: AppEnv["Bindings"],
  writer: DeployJobWriter,
  result: DeploymentResult,
): Promise<void> {
  const account = writer.job.options.accountName || writer.job.options.accountId;
  await writer.update({ status: "succeeded", result }, { flush: false });
  await writer.appendLog("info", "Deployment complete.", { flush: false });
  trackEvent(env, "deploy_success", writer.job.options.version, "", writer.job.id, writer.job.options.instance, account, writer.job.options.accountId);
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
  trackEvent(env, "deploy_failed", writer.job.options.version, "", writer.job.id, writer.job.options.instance, account, writer.job.options.accountId);
  await writer.flush(true);
}

export function resolveReleaseComponents(
  topology: ReleaseTopology,
  checksums: ReadonlyMap<string, string>,
): ReleaseComponent[] {
  const missingBundles: string[] = [];
  for (const component of topology.components) {
    if (!checksums.has(component.bundleFile)) {
      missingBundles.push(component.bundleFile);
    }
  }
  if (missingBundles.length > 0) {
    throw new Error(
      `Unsupported GSV release: the release does not include the complete stack (${missingBundles.join(", ")}). Choose Latest stable and try again.`,
    );
  }
  return topology.components;
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

type DetectableWorkerScript = {
  id: string;
  tags?: readonly string[];
};

type DetectedComponent = {
  scriptName: string;
  verified: boolean;
};

export function detectGsvInstallations(
  account: Account,
  workerScripts: DetectableWorkerScript[],
): ExistingGsvInstallation[] {
  const scripts = new Map(workerScripts.map((script) => [script.id, script]));
  const instances = new Map<string, Map<string, DetectedComponent>>();

  const addCandidate = (instance: string, component: string, script: DetectableWorkerScript): void => {
    let components = instances.get(instance);
    if (!components) {
      components = new Map<string, DetectedComponent>();
      instances.set(instance, components);
    }
    let canonicalScriptName = false;
    try {
      canonicalScriptName =
        scriptNameForComponent(parseInstance(instance), component) === script.id;
    } catch {
      canonicalScriptName = false;
    }
    const candidate = {
      scriptName: script.id,
      verified:
        canonicalScriptName &&
        hasExpectedWorkerTags(script.tags ?? [], instance, component),
    };
    const existing = components.get(component);
    if (!existing?.verified || candidate.verified) components.set(component, candidate);
  };

  // Tags are authoritative and let us discover a named gateway even when it is
  // the only deployed component. Names remain a read-only compatibility path
  // for installs that predate GSV management tags.
  for (const script of workerScripts) {
    const identity = managedWorkerIdentity(script);
    if (identity) addCandidate(identity.instance, identity.component, script);
  }

  for (const script of workerScripts) {
    const match = componentForScriptName(script.id);
    if (match) addCandidate(match.instance, match.component, script);
  }

  for (const instance of instances.keys()) {
    const gateway = scripts.get(instance);
    if (gateway) addCandidate(instance, COMPONENT_GATEWAY, gateway);
  }
  const defaultGateway = scripts.get(SCRIPT_GATEWAY);
  if (defaultGateway) addCandidate(DEFAULT_DEPLOY_INSTANCE, COMPONENT_GATEWAY, defaultGateway);

  return [...instances]
    .filter(([, components]) => components.size > 0)
    .map(([instance, detected]) => {
      const components = [...detected.keys()].sort((a, b) => deployOrder(a) - deployOrder(b));
      return {
        accountId: account.id,
        accountName: account.name?.trim() || account.id,
        instance,
        components,
        scriptNames: components.map((component) => detected.get(component)!.scriptName),
        deleteSupported: [...detected.values()].every((component) => component.verified),
      };
    });
}

function managedWorkerIdentity(
  script: DetectableWorkerScript,
): { instance: string; component: string } | null {
  const tags = script.tags ?? [];
  if (!tags.includes(WORKER_TAG_MANAGED)) return null;

  const instances = prefixedTagValues(tags, WORKER_TAG_INSTANCE_PREFIX);
  const components = prefixedTagValues(tags, WORKER_TAG_COMPONENT_PREFIX);
  if (instances.length !== 1 || components.length !== 1) return null;

  const instance = instances[0];
  const component = components[0];
  if (!instance || !component || !isDeployableComponent(component)) return null;

  try {
    if (scriptNameForComponent(parseInstance(instance), component) !== script.id) return null;
  } catch {
    return null;
  }
  return { instance, component };
}

function workerTagsForComponent(instance: string, component: string): string[] {
  return [
    WORKER_TAG_MANAGED,
    `${WORKER_TAG_INSTANCE_PREFIX}${instance}`,
    `${WORKER_TAG_COMPONENT_PREFIX}${component}`,
  ];
}

function hasExpectedWorkerTags(tags: readonly string[], instance: string, component: string): boolean {
  const managedTags = [...new Set(tags.filter((tag) => tag.startsWith("gsv-managed-")))];
  const instanceTags = prefixedTagValues(tags, WORKER_TAG_INSTANCE_PREFIX);
  const componentTags = prefixedTagValues(tags, WORKER_TAG_COMPONENT_PREFIX);
  return (
    managedTags.length === 1 &&
    managedTags[0] === WORKER_TAG_MANAGED &&
    instanceTags.length === 1 &&
    instanceTags[0] === instance &&
    componentTags.length === 1 &&
    componentTags[0] === component
  );
}

function prefixedTagValues(tags: readonly string[], prefix: string): string[] {
  return [...new Set(tags.filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length)))];
}

function componentForScriptName(scriptName: string): { instance: string; component: string } | null {
  if (scriptName === SCRIPT_RIPGIT) return { instance: DEFAULT_DEPLOY_INSTANCE, component: COMPONENT_RIPGIT };
  const channelMarker = scriptName.lastIndexOf("-channel-");
  if (channelMarker > 0) {
    const instance = scriptName.slice(0, channelMarker);
    const adapterId = scriptName.slice(channelMarker + "-channel-".length);
    if (/^[a-z][a-z0-9-]*$/.test(adapterId)) {
      return { instance, component: `channel-${adapterId}` };
    }
  }
  const suffixes: Array<[string, string]> = [
    ["-assembler", LEGACY_COMPONENT_ASSEMBLER],
    ["-ripgit", COMPONENT_RIPGIT],
  ];
  for (const [suffix, component] of suffixes) {
    if (!scriptName.endsWith(suffix)) continue;
    const instance = scriptName.slice(0, -suffix.length);
    return instance ? { instance, component } : null;
  }
  return scriptName === SCRIPT_GATEWAY ? { instance: DEFAULT_DEPLOY_INSTANCE, component: COMPONENT_GATEWAY } : null;
}

function componentForInstallationScriptName(instance: string, scriptName: string): string | null {
  if (scriptName === instance) return COMPONENT_GATEWAY;
  const match = componentForScriptName(scriptName);
  return match?.instance === instance ? match.component : null;
}

function isDeployableComponent(component: string): boolean {
  return component === COMPONENT_GATEWAY ||
    component === COMPONENT_RIPGIT ||
    component === LEGACY_COMPONENT_ASSEMBLER ||
    /^channel-[a-z][a-z0-9-]*$/.test(component);
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function friendlyErrorDetail(message: string): string {
  return getDeployHelp(message).detail;
}

function deployOrder(component: string): number {
  switch (component) {
    case COMPONENT_RIPGIT:
      return 0;
    case LEGACY_COMPONENT_ASSEMBLER:
      return 1;
    case COMPONENT_GATEWAY:
      return 10;
    default:
      return component.startsWith("channel-") ? 5 : 100;
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
      name.endsWith("-assembler") ||
      name.endsWith("-ripgit") ||
      name.includes("-channel-"))
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
    case LEGACY_COMPONENT_ASSEMBLER:
      return `${instance.name}-assembler`;
    case COMPONENT_RIPGIT:
      return instance.isDefault ? SCRIPT_RIPGIT : `${instance.name}-ripgit`;
    default:
      if (/^channel-[a-z][a-z0-9-]*$/.test(component)) {
        return `${instance.name}-${component}`;
      }
      throw new Error(`Unsupported component: ${component}`);
  }
}

function selectedOrExistingScripts(
  selectedComponents: Set<string>,
  existingScripts: Set<string>,
  instance: DeployInstance,
): Set<string> {
  const scripts = new Set(existingScripts);
  for (const component of selectedComponents) {
    scripts.add(scriptNameForComponent(instance, component));
  }
  return scripts;
}

function assertGatewayDependenciesAvailable(
  selectedComponents: Set<string>,
  availableScripts: Set<string>,
  instance: DeployInstance,
): void {
  if (!selectedComponents.has(COMPONENT_GATEWAY)) return;
  if (!availableScripts.has(scriptNameForComponent(instance, COMPONENT_RIPGIT))) {
    throw new Error("Deploying gateway requires ripgit. Select ripgit or deploy it first.");
  }
  if (
    selectedComponents.has(LEGACY_COMPONENT_ASSEMBLER) &&
    !availableScripts.has(scriptNameForComponent(instance, LEGACY_COMPONENT_ASSEMBLER))
  ) {
    throw new Error("The selected gateway release requires the legacy assembler Worker.");
  }
}

function scriptNameForConfigService(instance: DeployInstance, service: string): string {
  switch (service) {
    case SCRIPT_GATEWAY:
      return scriptNameForComponent(instance, COMPONENT_GATEWAY);
    case LEGACY_SCRIPT_ASSEMBLER:
      return scriptNameForComponent(instance, LEGACY_COMPONENT_ASSEMBLER);
    case SCRIPT_RIPGIT:
      return scriptNameForComponent(instance, COMPONENT_RIPGIT);
    default:
      if (service.startsWith(`${SCRIPT_GATEWAY}-channel-`)) {
        return scriptNameForComponent(
          instance,
          service.slice(`${SCRIPT_GATEWAY}-`.length),
        );
      }
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
  instance: DeployInstance,
  logger: InfoLogger,
  source: ReleaseArtifactSource,
): Promise<PreparedRelease> {
  const checksumsUrl = releaseDownloadUrl(repoOwner, repoName, version, BUNDLE_CHECKSUMS);
  await logger.info(`Fetching checksums from ${checksumsUrl}.`);
  const checksumsAsset = await fetchReleaseAsset(env, repoOwner, repoName, version, BUNDLE_CHECKSUMS, "Fetch bundle checksums", logger, source);
  const checksumsText = decodeText(checksumsAsset.bytes);
  const checksums = parseChecksums(checksumsText);
  const bundles: PreparedBundle[] = [];
  const validatedAssets: FetchedReleaseAsset[] = [checksumsAsset];
  const topology = await loadReleaseTopology(
    env,
    repoOwner,
    repoName,
    version,
    checksums,
    logger,
    source,
    validatedAssets,
  );
  const releaseComponents = resolveReleaseComponents(topology, checksums);

  for (const component of releaseComponents) {
    const expected = checksums.get(component.bundleFile);
    if (!expected) throw new Error(`Missing checksum entry for ${component.bundleFile}.`);

    await logger.info(`Downloading ${component.id} bundle.`);
    const bundleAsset = await fetchReleaseAsset(env, repoOwner, repoName, version, component.bundleFile, `Download ${component.id} bundle`, logger, source);
    const bytes = bundleAsset.bytes;
    const actual = await sha256Hex(bytes);
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${component.bundleFile}: expected ${expected}, got ${actual}.`);
    }
    await logger.info(`Checksum OK for ${component.bundleFile}.`);
    bundles.push(await prepareBundle(component, bytes, instance));
    validatedAssets.push(bundleAsset);
  }

  await cacheValidatedReleaseAssets(env, repoOwner, repoName, version, source, validatedAssets, logger);
  return { bundles, topology };
}

async function loadReleaseTopology(
  env: AppEnv["Bindings"],
  repoOwner: string,
  repoName: string,
  version: string,
  checksums: ReadonlyMap<string, string>,
  logger: InfoLogger,
  source: ReleaseArtifactSource,
  validatedAssets: FetchedReleaseAsset[],
): Promise<ReleaseTopology> {
  const expected = checksums.get(DEPLOYMENT_MANIFEST_FILE);
  if (!expected) {
    await logger.info(
      "This release predates the deployment manifest; discovering its bundled adapters from checksums.",
    );
    return legacyTopologyFromChecksums(checksums);
  }

  const asset = await fetchReleaseAsset(
    env,
    repoOwner,
    repoName,
    version,
    DEPLOYMENT_MANIFEST_FILE,
    "Download deployment manifest",
    logger,
    source,
  );
  const actual = await sha256Hex(asset.bytes);
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${DEPLOYMENT_MANIFEST_FILE}: expected ${expected}, got ${actual}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(asset.bytes));
  } catch {
    throw new Error("The GSV deployment manifest is not valid JSON.");
  }
  const manifest = parseGsvReleaseManifest(parsed);
  validatedAssets.push(asset);
  await logger.info(
    `Deployment manifest verified with ${manifest.adapters.length} bundled adapter${manifest.adapters.length === 1 ? "" : "s"}.`,
  );
  return topologyFromManifest(manifest);
}

function releaseDownloadUrl(repoOwner: string, repoName: string, tag: string, fileName: string): string {
  const base = `https://github.com/${repoOwner}/${repoName}/releases/download/${tag}/${fileName}`;
  return tag.toLowerCase() === "dev" ? `${base}?ts=${Date.now()}` : base;
}

async function fetchReleaseAsset(
  env: AppEnv["Bindings"],
  repoOwner: string,
  repoName: string,
  version: string,
  fileName: string,
  context: string,
  logger: InfoLogger,
  source: ReleaseArtifactSource,
): Promise<FetchedReleaseAsset> {
  if (source.kind === "snapshot") {
    return {
      fileName,
      bytes: await readRequiredReleaseAssetCache(
        env.RELEASE_CACHE,
        deploymentArtifactCacheKey(source.snapshotPrefix, fileName),
        fileName,
      ),
    };
  }

  const url = releaseDownloadUrl(repoOwner, repoName, version, fileName);
  let cacheKey: string | undefined;

  if (shouldCacheReleaseAsset(version)) {
    cacheKey = releaseCacheKey(repoOwner, repoName, version, fileName);
    const cached = await readReleaseAssetCache(env.RELEASE_CACHE, cacheKey, fileName, logger);
    if (cached) return { fileName, bytes: cached };
  }

  return { fileName, bytes: await fetchBytes(url, context), cacheKey };
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

async function cacheValidatedReleaseAssets(
  env: AppEnv["Bindings"],
  repoOwner: string,
  repoName: string,
  version: string,
  source: ReleaseArtifactSource,
  assets: FetchedReleaseAsset[],
  logger: InfoLogger,
): Promise<void> {
  if (source.kind !== "release") return;

  for (const asset of assets) {
    await writeDeploymentArtifactCache(
      env.RELEASE_CACHE,
      source.snapshotPrefix,
      asset.fileName,
      repoOwner,
      repoName,
      version,
      asset.bytes,
    );
    if (asset.cacheKey) {
      await writeReleaseAssetCache(
        env.RELEASE_CACHE,
        asset.cacheKey,
        asset.fileName,
        repoOwner,
        repoName,
        version,
        asset.bytes,
        logger,
      );
    }
  }
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
  if (fileName.endsWith(".json")) return "application/json; charset=utf-8";
  if (fileName.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupDeploymentArtifactPrefix(
  env: AppEnv["Bindings"],
  artifactCachePrefix: string,
  logger: InfoLogger,
  throwOnError = false,
): Promise<void> {
  try {
    let cursor: string | undefined;
    do {
      const listed = await env.RELEASE_CACHE.list({
        prefix: `${artifactCachePrefix}/`,
        cursor,
      });
      const keys = listed.objects.map((object) => object.key);
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        if (batch.length) await env.RELEASE_CACHE.delete(batch);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (error) {
    await logger.info(`Failed to clean up deployment release artifacts: ${errorMessage(error)}.`);
    if (throwOnError) throw error;
  }
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
  component: ReleaseComponent,
  compressedBytes: Uint8Array,
  instance: DeployInstance,
): Promise<PreparedBundle> {
  const entries = parseTar(ungzip(compressedBytes));
  const files = normalizeBundleFiles(entries, component.id);
  const manifest = readJson<BundleManifest>(files, "manifest.json");
  if (manifest.component !== component.id) {
    throw new Error(
      `Bundle ${component.bundleFile} identifies component ${manifest.component} instead of ${component.id}.`,
    );
  }
  const wranglerPath = manifest.worker.wranglerConfig ?? manifest.worker.wrangler_config ?? "wrangler.jsonc";
  const wrangler = parseWranglerConfig(wranglerPath, readText(files, wranglerPath));
  wrangler.name = scriptNameForComponent(instance, component.id);

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
    component: component.id,
    ...(component.adapter ? { adapter: component.adapter } : {}),
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

async function listWorkerScripts(accessToken: string, accountId: string): Promise<Map<string, WorkerScriptDetails>> {
  const result = await cloudflareApi<unknown>(accessToken, `/accounts/${accountId}/workers/scripts`, {}, "List Workers scripts");
  const scripts = decodeList<WorkerScriptSummary>(result, ["scripts", "items"]);
  const out = new Map<string, WorkerScriptDetails>();
  for (const script of scripts) {
    out.set(script.id, {
      migrationTag: script.migration_tag ?? null,
      tags: Array.isArray(script.tags) ? script.tags.filter((tag): tag is string => typeof tag === "string") : [],
    });
  }
  return out;
}

export function workersPaidFromAccountSettings(settings: WorkersAccountSettings): boolean {
  return settings.default_usage_model?.trim().toLowerCase() === "standard";
}

async function resolveWorkersPaid(
  accessToken: string,
  accountId: string,
  logger: DeployLogger,
): Promise<boolean> {
  try {
    const settings = await cloudflareApi<WorkersAccountSettings>(
      accessToken,
      `/accounts/${accountId}/workers/account-settings`,
      {},
      "Fetch Worker account settings",
    );
    const workersPaid = workersPaidFromAccountSettings(settings);
    await logger.info(
      workersPaid
        ? "Workers Standard detected; enabling CodeMode and ripgit's extended CPU limit."
        : "Workers Free or a legacy usage model detected; omitting CodeMode and paid-only Worker limits.",
    );
    return workersPaid;
  } catch (error) {
    await logger.warning(
      `Could not verify the Workers plan; deploying the Free-compatible configuration without CodeMode or paid-only Worker limits: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return false;
  }
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
  adapters: ReleaseAdapter[];
  accountSubdomain: string | null;
  existingMigrationTag: string | null;
  includeMigrations: boolean;
  scriptExists: boolean;
  uploadedAssets: UploadedAssets | null;
  keepAssets: boolean;
  workersPaid: boolean;
  logger: InfoLogger;
};

export async function buildUploadMetadata(
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
    if (service.props) value.props = service.props;
    bindings.push(value);
  }

  if (options.workersPaid) {
    for (const loader of bundle.wrangler.worker_loaders ?? []) {
      bindings.push({ name: loader.binding, type: "worker_loader" });
    }
  }

  if (bundle.wrangler.ai) {
    const value: Record<string, unknown> = {
      name: bundle.wrangler.ai.binding,
      type: "ai",
    };
    if (typeof bundle.wrangler.ai.staging === "boolean") value.staging = bundle.wrangler.ai.staging;
    bindings.push(value);
  }

  const selfUrlBinding = bundle.adapter?.standalone.selfUrlBinding ??
    (bundle.component === "channel-telegram" ? "TELEGRAM_WEBHOOK_BASE_URL" : undefined);
  if (selfUrlBinding && options.accountSubdomain) {
    bindings.push({
      name: selfUrlBinding,
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
    tags: workerTagsForComponent(options.instance.name, bundle.component),
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
  const paidLimits = paidLimitsForBundle(bundle);
  if (options.workersPaid && paidLimits) metadata.limits = paidLimits;
  if (options.uploadedAssets) {
    metadata.assets = { jwt: options.uploadedAssets.jwt, config: options.uploadedAssets.config };
  }
  if (options.keepAssets) metadata.keep_assets = true;

  return metadata;
}

function paidLimitsForBundle(bundle: PreparedBundle): NonNullable<WranglerConfig["limits"]> | undefined {
  if (bundle.wrangler.limits) return bundle.wrangler.limits;
  if (bundle.component === COMPONENT_RIPGIT) return { cpu_ms: RIPGIT_PAID_CPU_LIMIT_MS };
  return undefined;
}

function serviceBindingsForBundle(
  bundle: PreparedBundle,
  options: Pick<
    MetadataOptions,
    "instance" | "selectedComponents" | "availableScripts" | "adapters"
  >,
): Array<{
  binding: string;
  service: string;
  environment?: string;
  entrypoint?: string;
  props?: { id: string; calls: string[] };
}> {
  let bindings = [...(bundle.wrangler.services ?? [])];
  const gatewayScriptName = scriptNameForComponent(options.instance, COMPONENT_GATEWAY);

  if (bundle.component === COMPONENT_GATEWAY && options.adapters.length > 0) {
    bindings = bindings.filter(
      (binding) => !binding.binding.startsWith("CHANNEL_"),
    );
    for (const adapter of options.adapters) {
      const component = `channel-${adapter.id}`;
      const service = scriptNameForComponent(options.instance, component);
      if (
        options.selectedComponents.has(component) ||
        options.availableScripts.has(service)
      ) {
        bindings.push({
          binding: adapter.gatewayBinding,
          service,
          entrypoint: adapter.standalone.gatewayEntrypoint,
        });
      }
    }
  }

  if (bundle.adapter) {
    bindings = bindings.filter((binding) => binding.binding !== "GATEWAY");
    if (
      options.selectedComponents.has(COMPONENT_GATEWAY) ||
      options.availableScripts.has(gatewayScriptName)
    ) {
      bindings.push({
        binding: "GATEWAY",
        service: gatewayScriptName,
        entrypoint: "AdapterGatewayEntrypoint",
        props: {
          id: bundle.adapter.id,
          calls: ["adapter.inbound", "adapter.state.update"],
        },
      });
    }
  }

  const out: Array<{
    binding: string;
    service: string;
    environment?: string;
    entrypoint?: string;
    props?: { id: string; calls: string[] };
  }> = [];
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
