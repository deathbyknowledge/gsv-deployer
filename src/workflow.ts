import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

import { runDeployJob } from "./deploy";
import { appendLog, deleteDeployToken, failActiveJobStep, getDeployToken, updateJob } from "./jobs";
import type { AppEnv, DeployWorkflowParams } from "./types";

export class GsvDeployWorkflow extends WorkflowEntrypoint<AppEnv["Bindings"], DeployWorkflowParams> {
  async run(event: WorkflowEvent<DeployWorkflowParams>, step: WorkflowStep): Promise<{ jobId: string }> {
    const { jobId } = event.payload;

    try {
      await step.do(
        "run deployment",
        {
          timeout: "30 minutes",
          retries: { limit: 2, delay: "30 seconds", backoff: "linear" },
          sensitive: "output",
        },
        async () => {
          const accessToken = await getDeployToken(this.env, jobId);
          if (!accessToken) {
            const message = "Deployment credentials expired before the workflow started. Please authorize Cloudflare again.";
            await failActiveJobStep(this.env, jobId, message);
            await appendLog(this.env, jobId, "error", message);
            await updateJob(this.env, jobId, { status: "failed", error: message });
            throw new Error(message);
          }

          await runDeployJob(this.env, jobId, accessToken);
          return { ok: true };
        },
      );
    } finally {
      await deleteDeployToken(this.env, jobId);
    }

    return { jobId };
  }
}
