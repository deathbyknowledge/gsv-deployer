import { describe, expect, it } from "vitest";

import { buildUploadMetadata } from "../src/deploy";

describe("buildUploadMetadata", () => {
  it("preserves worker runtime limits", async () => {
    const metadata = await buildUploadMetadata(
      "access-token",
      "account-id",
      {
        component: "ripgit",
        manifest: {
          component: "ripgit",
          worker: { entrypoint: "worker/index.js" },
        },
        files: new Map(),
        wrangler: {
          name: "ripgit",
          compatibility_date: "2026-03-18",
          limits: {
            cpu_ms: 300_000,
            subrequests: 1_000,
          },
        },
        scriptName: "ripgit",
        entrypointPartName: "index.js",
        entrypointBytes: new Uint8Array(),
        additionalModules: [],
      },
      {
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
        logger: { async info() {} },
      },
    );

    expect(metadata.limits).toEqual({
      cpu_ms: 300_000,
      subrequests: 1_000,
    });
  });
});
