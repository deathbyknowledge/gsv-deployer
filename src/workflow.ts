import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { runDeployWorkflow } from "./deploy";
import { runDeleteWorkflow } from "./deletion";
import type { AppEnv, DeleteWorkflowParams, DeployWorkflowParams } from "./types";

export class GsvDeployWorkflow extends WorkflowEntrypoint<AppEnv["Bindings"], DeployWorkflowParams> {
  async run(event: WorkflowEvent<DeployWorkflowParams>, step: WorkflowStep): Promise<{ jobId: string }> {
    const { jobId } = event.payload;

    await runDeployWorkflow(this.env, jobId, step);
    return { jobId };
  }
}

export class GsvDeleteWorkflow extends WorkflowEntrypoint<AppEnv["Bindings"], DeleteWorkflowParams> {
  async run(event: WorkflowEvent<DeleteWorkflowParams>, step: WorkflowStep): Promise<{ jobId: string; continued: boolean }> {
    const { jobId, pass } = event.payload;
    if (!Number.isInteger(pass) || pass < 0) throw new Error("Deletion workflow pass must be a non-negative integer.");

    const result = await runDeleteWorkflow(this.env, jobId, pass, step);
    return { jobId, continued: result.continued };
  }
}
