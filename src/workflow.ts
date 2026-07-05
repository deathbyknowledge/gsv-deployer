import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { runDeployWorkflow } from "./deploy";
import type { AppEnv, DeployWorkflowParams } from "./types";

export class GsvDeployWorkflow extends WorkflowEntrypoint<AppEnv["Bindings"], DeployWorkflowParams> {
  async run(event: WorkflowEvent<DeployWorkflowParams>, step: WorkflowStep): Promise<{ jobId: string }> {
    const { jobId } = event.payload;

    await runDeployWorkflow(this.env, jobId, step);
    return { jobId };
  }
}
