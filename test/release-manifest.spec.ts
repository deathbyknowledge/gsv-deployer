import { describe, expect, it } from "vitest";

import {
  DEPLOYMENT_MANIFEST_FILE,
  legacyTopologyFromChecksums,
  parseGsvReleaseManifest,
  topologyFromManifest,
} from "../src/release-manifest";

const manifest = {
  version: 1,
  runtime: {
    gatewayBundle: "dist/cloudflare/gateway/worker/index.js",
    webAssets: "dist/cloudflare/gateway/assets",
    ripgitBundle: "dist/cloudflare/ripgit/worker/index.js",
  },
  adapters: [{
    id: "matrix",
    displayName: "Matrix",
    gatewayBinding: "CHANNEL_MATRIX",
    standalone: {
      main: "dist/cloudflare/channel-matrix/worker/index.js",
      bundle: false,
      gatewayEntrypoint: "MatrixChannel",
      adapterEntrypoint: "MatrixChannel",
      durableObjects: [{ binding: "MATRIX_ACCOUNT", className: "MatrixAccount" }],
      requiredSecrets: [],
      selfUrlBinding: "MATRIX_WEBHOOK_BASE_URL",
    },
  }],
};

describe("release deployment manifest", () => {
  it("derives a complete deployment without knowing adapter brands", () => {
    const parsed = parseGsvReleaseManifest(manifest);
    expect(topologyFromManifest(parsed)).toEqual({
      manifest: {
        version: 1,
        adapters: [{
          id: "matrix",
          displayName: "Matrix",
          gatewayBinding: "CHANNEL_MATRIX",
          standalone: {
            gatewayEntrypoint: "MatrixChannel",
            adapterEntrypoint: "MatrixChannel",
            requiredSecrets: [],
            selfUrlBinding: "MATRIX_WEBHOOK_BASE_URL",
          },
        }],
      },
      components: [
        { id: "ripgit", bundleFile: "gsv-cloudflare-ripgit.tar.gz" },
        {
          id: "channel-matrix",
          bundleFile: "gsv-cloudflare-channel-matrix.tar.gz",
          adapter: expect.objectContaining({ id: "matrix" }),
        },
        { id: "gateway", bundleFile: "gsv-cloudflare-gateway.tar.gz" },
      ],
    });
    expect(DEPLOYMENT_MANIFEST_FILE).toBe(
      "gsv-cloudflare-deployment-manifest.json",
    );
  });

  it("discovers old release channels from checksums", () => {
    const topology = legacyTopologyFromChecksums(new Map([
      ["gsv-cloudflare-gateway.tar.gz", "a"],
      ["gsv-cloudflare-ripgit.tar.gz", "b"],
      ["gsv-cloudflare-channel-signal.tar.gz", "c"],
      ["gsv-cloudflare-assembler.tar.gz", "d"],
    ]));
    expect(topology.components.map((component) => component.id)).toEqual([
      "ripgit",
      "assembler",
      "channel-signal",
      "gateway",
    ]);
  });

  it("rejects duplicate trusted binding identities", () => {
    expect(() => parseGsvReleaseManifest({
      ...manifest,
      adapters: [manifest.adapters[0], { ...manifest.adapters[0], id: "other" }],
    })).toThrow("Duplicate adapter gateway binding");
  });
});
