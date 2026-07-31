import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_COMPONENTS,
  buildUploadMetadata,
  completeDeployOptions,
  deleteGsvInstallation,
  detectGsvInstallations,
  resolveReleaseComponents,
  workersPaidFromSubscriptions,
} from "../src/deploy";

type UploadBundle = Parameters<typeof buildUploadMetadata>[2];
type MetadataOptions = Parameters<typeof buildUploadMetadata>[3];

describe("deployment compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deploys only current GSV components", () => {
    expect(ALL_COMPONENTS).not.toContain("assembler");
    expect(completeDeployOptions({
      accountId: "account-id",
      instance: "gsv",
      version: "latest",
    }).components).toEqual(ALL_COMPONENTS);
  });

  it("derives legacy assembler compatibility from the release checksums", () => {
    const currentChecksums = new Map([
      ["gsv-cloudflare-ripgit.tar.gz", "ripgit-hash"],
      ["gsv-cloudflare-gateway.tar.gz", "gateway-hash"],
    ]);
    expect(resolveReleaseComponents(["ripgit", "assembler", "gateway"], currentChecksums)).toEqual([
      "ripgit",
      "gateway",
    ]);

    const legacyChecksums = new Map(currentChecksums);
    legacyChecksums.set("gsv-cloudflare-assembler.tar.gz", "assembler-hash");
    expect(resolveReleaseComponents(["ripgit", "gateway"], legacyChecksums)).toEqual([
      "ripgit",
      "assembler",
      "gateway",
    ]);

    expect(() => resolveReleaseComponents(["gateway"], new Map())).toThrow(
      "Missing checksum entry for gsv-cloudflare-gateway.tar.gz.",
    );
  });

  it("adds paid Worker features only for verified paid accounts", async () => {
    const bundle = ripgitBundle();
    bundle.wrangler.worker_loaders = [{ binding: "LOADER" }];

    const paidMetadata = await buildUploadMetadata(
      "access-token",
      "account-id",
      bundle,
      metadataOptions(true),
    );
    const freeMetadata = await buildUploadMetadata(
      "access-token",
      "account-id",
      bundle,
      metadataOptions(false),
    );

    expect(paidMetadata.bindings).toContainEqual({ name: "LOADER", type: "worker_loader" });
    expect(paidMetadata.limits).toEqual({ cpu_ms: 300_000 });
    expect(freeMetadata.bindings).not.toContainEqual({ name: "LOADER", type: "worker_loader" });
    expect(freeMetadata).not.toHaveProperty("limits");
    expect(freeMetadata.tags).toEqual([
      "gsv-managed-v1",
      "gsv-instance-gsv",
      "gsv-component-ripgit",
    ]);
  });

  it("preserves release-provided limits for verified paid accounts", async () => {
    const bundle = ripgitBundle();
    bundle.wrangler.limits = { cpu_ms: 200_000, subrequests: 1_000 };

    const metadata = await buildUploadMetadata(
      "access-token",
      "account-id",
      bundle,
      metadataOptions(true),
    );

    expect(metadata.limits).toEqual({ cpu_ms: 200_000, subrequests: 1_000 });
  });

  it("requires an active account-scoped Workers Paid subscription", () => {
    expect(workersPaidFromSubscriptions([
      {
        rate_plan: { id: "workers_paid", scope: "account" },
        state: "Paid",
      },
    ])).toBe(true);

    for (const subscription of [
      { rate_plan: { id: "workers_paid", scope: "zone" }, state: "Paid" },
      { rate_plan: { id: "free", scope: "account" }, state: "Paid" },
      { rate_plan: { id: "workers_paid", scope: "account" }, state: "Cancelled" },
    ]) {
      expect(workersPaidFromSubscriptions([subscription])).toBe(false);
    }
  });

  it("uses management tags as the deletion boundary while retaining legacy discovery", () => {
    const account = { id: "account-id", name: "Account" };
    const managed = detectGsvInstallations(account, [
      { id: "gsv", tags: workerTags("gsv", "gateway") },
      { id: "ripgit", tags: workerTags("gsv", "ripgit") },
    ]);
    expect(managed).toEqual([
      expect.objectContaining({
        instance: "gsv",
        components: ["ripgit", "gateway"],
        scriptNames: ["ripgit", "gsv"],
        deleteSupported: true,
      }),
    ]);

    const legacy = detectGsvInstallations(account, [
      { id: "gsv" },
      { id: "ripgit" },
    ]);
    expect(legacy[0]).toEqual(expect.objectContaining({ instance: "gsv", deleteSupported: false }));

    const mixedLegacy = detectGsvInstallations(account, [
      { id: "gsv", tags: workerTags("gsv", "gateway") },
      { id: "ripgit", tags: workerTags("gsv", "ripgit") },
      { id: "gsv-assembler" },
    ]);
    expect(mixedLegacy[0]).toEqual(
      expect.objectContaining({
        components: ["ripgit", "assembler", "gateway"],
        deleteSupported: false,
      }),
    );

    const taggedGatewayOnly = detectGsvInstallations(account, [
      { id: "gsv-work", tags: workerTags("gsv-work", "gateway") },
    ]);
    expect(taggedGatewayOnly[0]).toEqual(
      expect.objectContaining({ instance: "gsv-work", components: ["gateway"], deleteSupported: true }),
    );

    const inconsistentName = detectGsvInstallations(account, [
      { id: "gsv-ripgit", tags: workerTags("gsv", "ripgit") },
    ]);
    expect(inconsistentName[0]).toEqual(expect.objectContaining({ deleteSupported: false }));
  });

  it("prefers verified management tags over colliding legacy names", () => {
    const account = { id: "account-id", name: "Account" };
    const installations = detectGsvInstallations(account, [
      { id: "gsv", tags: workerTags("gsv", "gateway") },
      { id: "ripgit", tags: workerTags("gsv", "ripgit") },
      { id: "gsv-ripgit" },
    ]);

    expect(installations).toEqual([
      expect.objectContaining({
        instance: "gsv",
        components: ["ripgit", "gateway"],
        scriptNames: ["ripgit", "gsv"],
        deleteSupported: true,
      }),
    ]);
  });

  it("keeps storage when any Worker deletion fails", async () => {
    const requests: string[] = [];
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
      if (method === "DELETE" && url.includes("/workers/scripts/gsv?")) {
        return cloudflareResponse(null, 500, [{ message: "delete failed" }]);
      }
      if (method === "DELETE" && url.includes("/workers/scripts/ripgit?")) {
        return cloudflareResponse(null);
      }
      if (url.includes("/r2/buckets/")) return cloudflareResponse(null);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const result = await deleteGsvInstallation(
      "access-token",
      {
        accountId: "account-id",
        accountName: "Account",
        instance: "gsv",
        components: ["ripgit", "gateway"],
        scriptNames: ["ripgit", "gsv"],
        deleteSupported: true,
      },
      { deleteStorage: true },
    );

    expect(result.failed).toEqual([expect.objectContaining({ script: "gsv" })]);
    expect(result.storage).toBeUndefined();
    expect(requests.some((request) => request.includes("/r2/buckets/"))).toBe(false);
  });

  it("revalidates management tags before the first deletion", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      if (method === "GET" && url.endsWith("/workers/scripts")) {
        return cloudflareResponse([
          { id: "gsv", tags: workerTags("another-instance", "gateway") },
        ]);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const result = await deleteGsvInstallation("access-token", {
      accountId: "account-id",
      accountName: "Account",
      instance: "gsv",
      components: ["gateway"],
      scriptNames: ["gsv"],
      deleteSupported: true,
    });

    expect(result.deleted).toEqual([]);
    expect(result.failed[0]?.error).toContain("ownership changed");
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  });
});

function workerTags(instance: string, component: string): string[] {
  return ["gsv-managed-v1", `gsv-instance-${instance}`, `gsv-component-${component}`];
}

function cloudflareResponse(result: unknown, status = 200, errors: Array<{ message: string }> = []): Response {
  return new Response(JSON.stringify({ success: status < 400, result, errors }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ripgitBundle(): UploadBundle {
  return {
    component: "ripgit",
    manifest: {
      component: "ripgit",
      worker: { entrypoint: "worker/index.js" },
    },
    files: new Map(),
    wrangler: {
      name: "ripgit",
      compatibility_date: "2026-03-18",
    },
    scriptName: "ripgit",
    entrypointPartName: "index.js",
    entrypointBytes: new Uint8Array(),
    additionalModules: [],
  };
}

function metadataOptions(workersPaid: boolean): MetadataOptions {
  return {
    instance: {
      name: "gsv",
      isDefault: true,
      storageBucketName: "gsv-storage",
    },
    selectedComponents: new Set(),
    availableScripts: new Set(),
    accountSubdomain: null,
    existingMigrationTag: null,
    includeMigrations: false,
    scriptExists: false,
    uploadedAssets: null,
    keepAssets: false,
    workersPaid,
    logger: { async info() {} },
  };
}
