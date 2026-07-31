import type { WorkflowStep } from "cloudflare:workers";

import {
  deleteGsvWorkers,
  deleteR2Bucket,
  deleteR2ObjectsBatch,
  storageBucketNameForInstance,
} from "./deploy";
import type { ExistingGsvInstallation } from "./deploy";
import {
  deleteDeployCredentials,
  DeleteJobWriter,
  getDeployCredentials,
} from "./jobs";
import type { AppEnv, DeleteJob } from "./types";

const DELETE_WORKFLOW_STEP_CONFIG = {
  timeout: "5 minutes",
  retries: { limit: 3, delay: "10 seconds", backoff: "linear" },
} as const;
const DELETE_WORKFLOW_CLEANUP_CONFIG = {
  timeout: "2 minutes",
  retries: { limit: 3, delay: "10 seconds", backoff: "linear" },
} as const;
// Each object batch uses at most 32 Cloudflare API deletions. Keeping one pass
// below the 1,024-step Workers Free limit lets this deployer clean large buckets
// without depending on paid-only Workflow limits. A successor pass continues
// from the now-smaller bucket when necessary.
const R2_BATCHES_PER_WORKFLOW_PASS = 1_000;

type DeletionPhase = {
  accessToken: string;
  writer: DeleteJobWriter;
};

export async function runDeleteWorkflow(
  env: AppEnv["Bindings"],
  jobId: string,
  pass: number,
  step: WorkflowStep,
): Promise<{ continued: boolean }> {
  let continued = false;
  try {
    if (pass === 0) {
      await step.do("delete GSV services", DELETE_WORKFLOW_STEP_CONFIG, async () =>
        withDeletionPhase(env, jobId, async ({ accessToken, writer }) => {
          await writer.update({ status: "running" }, { flush: false });
          await writer.updateStep(
            "workers",
            "running",
            "Removing GSV services and their Durable Object data.",
            { flush: false },
          );
          const result = await deleteGsvWorkers(accessToken, installationFromJob(writer.job));
          if (result.failed.length > 0) {
            const scripts = result.failed.map((failure) => failure.script).join(", ");
            throw new Error(`Could not delete GSV services (${scripts}): ${result.failed[0]?.error ?? "Unknown error"}`);
          }
          await writer.update(
            {
              result: {
                bucketName: storageBucketNameForInstance(writer.job.options.instance),
                deletedWorkers: result.deleted.length,
              },
            },
            { flush: false },
          );
          await writer.updateStep(
            "workers",
            "complete",
            "GSV services and their Durable Object data were removed.",
            { flush: false },
          );
          await writer.appendLog("info", "Removed GSV services and Durable Object data.", { flush: false });
          return { deleted: result.deleted.length };
        }),
      );
    }

    let storageEmpty = false;
    let bucketMissing = false;
    for (let batch = 0; batch < R2_BATCHES_PER_WORKFLOW_PASS; batch += 1) {
      const result = await step.do(
        `delete stored files batch ${batch + 1}`,
        DELETE_WORKFLOW_STEP_CONFIG,
        async () =>
          withDeletionPhase(env, jobId, async ({ accessToken, writer }) => {
            const bucketName = storageBucketNameForInstance(writer.job.options.instance);
            await writer.update({ status: "running" }, { flush: false });
            await writer.updateStep(
              "storage",
              "running",
              `Permanently removing files from ${bucketName}.`,
              { flush: false },
            );
            return deleteR2ObjectsBatch(accessToken, writer.job.options.accountId, bucketName);
          }),
      );
      if (result.empty) {
        storageEmpty = true;
        bucketMissing = result.bucketMissing;
        break;
      }
    }

    if (!storageEmpty) {
      await step.do("continue storage deletion", DELETE_WORKFLOW_STEP_CONFIG, async () => {
        await withDeletionPhase(env, jobId, async ({ writer }) => {
          await writer.appendLog("info", "Continuing storage cleanup in another durable pass.");
          return { ok: true };
        });
        await ensureContinuationWorkflow(env, jobId, pass + 1);
        return { continued: true };
      });
      continued = true;
      return { continued };
    }

    if (!bucketMissing) {
      await step.do("delete R2 bucket", DELETE_WORKFLOW_STEP_CONFIG, async () =>
        withDeletionPhase(env, jobId, async ({ accessToken, writer }) => {
          const bucketName = storageBucketNameForInstance(writer.job.options.instance);
          await deleteR2Bucket(accessToken, writer.job.options.accountId, bucketName);
          return { bucketName };
        }),
      );
    }

    await step.do("record deletion success", DELETE_WORKFLOW_CLEANUP_CONFIG, async () => {
      const writer = await DeleteJobWriter.load(env, jobId);
      if (!writer) return { ok: true };
      const bucketName = storageBucketNameForInstance(writer.job.options.instance);
      await writer.updateStep(
        "storage",
        "complete",
        bucketMissing
          ? "The R2 storage bucket was already gone."
          : "All files and the R2 storage bucket were removed.",
        { flush: false },
      );
      await writer.updateStep("finish", "complete", "This GSV was completely deleted.", { flush: false });
      await writer.appendLog("info", "Deletion complete.", { flush: false });
      await writer.update({ status: "succeeded", error: undefined }, { flush: false });
      await writer.flush(true);
      return { bucketName };
    });
    return { continued };
  } catch (error) {
    try {
      await step.do("record deletion failure", DELETE_WORKFLOW_CLEANUP_CONFIG, async () => {
        await recordDeletionFailure(env, jobId, error);
        return { ok: true };
      });
    } catch (recordError) {
      logDeletionMaintenanceError(jobId, "record deletion failure", recordError);
    }
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  } finally {
    if (!continued) {
      try {
        await step.do("cleanup deletion credentials", DELETE_WORKFLOW_CLEANUP_CONFIG, async () => {
          await deleteDeployCredentials(env, jobId);
          return { ok: true };
        });
      } catch (error) {
        logDeletionMaintenanceError(jobId, "cleanup deletion credentials", error);
      }
    }
  }
}

async function withDeletionPhase<T>(
  env: AppEnv["Bindings"],
  jobId: string,
  callback: (phase: DeletionPhase) => Promise<T>,
): Promise<T> {
  const writer = await DeleteJobWriter.load(env, jobId);
  if (!writer) throw new Error(`Deletion job ${jobId} was not found.`);
  const credentials = await getDeployCredentials(env, jobId);
  if (!credentials) throw new Error("Deletion credentials expired. Please start the deletion again.");

  try {
    return await callback({ accessToken: credentials.accessToken, writer });
  } finally {
    await writer.flush();
  }
}

async function ensureContinuationWorkflow(
  env: AppEnv["Bindings"],
  jobId: string,
  pass: number,
): Promise<void> {
  const id = `${jobId}-storage-${pass}`;
  try {
    await env.DELETE_WORKFLOW.create({
      id,
      params: { jobId, pass },
      retention: {
        successRetention: "1 day",
        errorRetention: "7 days",
      },
    });
  } catch (error) {
    // Workflow steps can be retried after their callback has already created the
    // successor. Treat an existing live/completed instance as idempotent success.
    const existing = await env.DELETE_WORKFLOW.get(id);
    const status = await existing.status();
    if (status.status === "unknown") throw error;
  }
}

async function recordDeletionFailure(env: AppEnv["Bindings"], jobId: string, error: unknown): Promise<void> {
  const writer = await DeleteJobWriter.load(env, jobId);
  if (!writer) return;
  const message = error instanceof Error ? error.message : String(error);
  if (writer.job.status === "failed" && writer.job.error === message) return;

  await writer.failActiveStep(deletionFailureDetail(message), { flush: false });
  await writer.appendLog("error", message, { flush: false });
  await writer.update({ status: "failed", error: message }, { flush: false });
  await writer.flush(true);
}

function deletionFailureDetail(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("ownership") || lower.includes("management tags")) {
    return "Deletion stopped because this installer could not verify that every remaining Worker belongs to this GSV.";
  }
  if (lower.includes("r2") || lower.includes("storage") || lower.includes("bucket")) {
    return "GSV services were removed, but Cloudflare could not finish deleting files or the storage bucket. Review the error and retry cleanup.";
  }
  return "Cloudflare could not finish deleting this GSV. Review the error below and retry.";
}

function installationFromJob(job: DeleteJob): ExistingGsvInstallation {
  return {
    accountId: job.options.accountId,
    accountName: job.options.accountName?.trim() || job.options.accountId,
    instance: job.options.instance,
    components: [],
    scriptNames: job.options.scriptNames,
    deleteSupported: true,
  };
}

function logDeletionMaintenanceError(jobId: string, operation: string, error: unknown): void {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    jobId,
    message: `Deletion workflow maintenance step failed: ${operation}`,
  }));
}
