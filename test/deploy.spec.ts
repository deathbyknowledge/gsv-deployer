import { describe, expect, it } from "vitest";

import {
  ALL_COMPONENTS,
  buildUploadMetadata,
  resolveReleaseComponents,
  workersPaidFromSubscriptions,
} from "../src/deploy";

type UploadBundle = Parameters<typeof buildUploadMetadata>[2];
type MetadataOptions = Parameters<typeof buildUploadMetadata>[3];

describe("deployment compatibility", () => {
  it("deploys only current GSV components", () => {
    expect(ALL_COMPONENTS).not.toContain("assembler");
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
});

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
