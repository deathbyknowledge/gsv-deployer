import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runDeleteWorkflow } from "../src/deletion";
import { createDeleteJob, getDeleteJob, getDeployCredentials } from "../src/jobs";
import type { AppEnv } from "../src/types";

const bindings = env as unknown as AppEnv["Bindings"];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GSV deletion workflow", () => {
  it("removes verified Workers before emptying and deleting R2 storage", async () => {
    const requests: string[] = [];
    let objectLists = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);

      if (method === "GET" && url.endsWith("/workers/scripts")) {
        return cloudflareResponse([
          { id: "gsv", tags: workerTags("gsv", "gateway") },
          { id: "ripgit", tags: workerTags("gsv", "ripgit") },
        ]);
      }
      if (method === "DELETE" && url.includes("/workers/scripts/")) {
        return cloudflareResponse(null);
      }
      if (method === "GET" && url.includes("/r2/buckets/gsv-storage/objects")) {
        objectLists += 1;
        return cloudflareResponse(objectLists === 1 ? [{ key: "repos/example/data" }] : []);
      }
      if (method === "DELETE" && url.includes("/r2/buckets/gsv-storage/objects/")) {
        return cloudflareResponse(null);
      }
      if (method === "DELETE" && url.endsWith("/r2/buckets/gsv-storage")) {
        return cloudflareResponse(null);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const { job } = await createDeleteJob(bindings, {
      sessionId: "session-id",
      options: {
        accountId: "account-id",
        accountName: "Test account",
        instance: "gsv",
        scriptNames: ["ripgit", "gsv"],
      },
      token: { access_token: "access-token", token_type: "Bearer" },
    });

    await expect(runDeleteWorkflow(bindings, job.id, 0, immediateWorkflowStep())).resolves.toEqual({
      continued: false,
    });

    const completed = await getDeleteJob(bindings, job.id);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.steps.map((item) => [item.id, item.status])).toEqual([
      ["authorize", "complete"],
      ["workers", "complete"],
      ["storage", "complete"],
      ["finish", "complete"],
    ]);
    expect(await getDeployCredentials(bindings, job.id)).toBeNull();

    const firstStorageRequest = requests.findIndex((request) => request.includes("/r2/buckets/"));
    const lastWorkerDeletion = requests.reduce(
      (last, request, index) => request.includes("DELETE") && request.includes("/workers/scripts/") ? index : last,
      -1,
    );
    expect(firstStorageRequest).toBeGreaterThan(lastWorkerDeletion);
    expect(requests.filter((request) => request.includes("/workers/scripts/")).every((request) => request.endsWith("?force=true"))).toBe(true);
    expect(requests.at(-1)).toContain("DELETE https://api.cloudflare.com/client/v4/accounts/account-id/r2/buckets/gsv-storage");
  });
});

function immediateWorkflowStep(): WorkflowStep {
  return {
    do: async (
      _name: string,
      configOrCallback: unknown,
      callback?: () => Promise<unknown>,
    ): Promise<unknown> => {
      const operation = callback ?? configOrCallback as () => Promise<unknown>;
      return operation();
    },
  } as unknown as WorkflowStep;
}

function workerTags(instance: string, component: string): string[] {
  return ["gsv-managed-v1", `gsv-instance-${instance}`, `gsv-component-${component}`];
}

function cloudflareResponse(result: unknown): Response {
  return Response.json({ success: true, result, errors: [] });
}
