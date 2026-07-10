import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

declare const process: { env: Record<string, string | undefined> };

for (const name of [
  "CF_OAUTH_CLIENT_ID",
  "CF_OAUTH_CLIENT_SECRET",
  "SESSION_SECRET",
  "CF_ANALYTICS_API_TOKEN",
  "METRICS_USER",
  "METRICS_PASSWORD",
]) {
  process.env[name] ??= "test-only";
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
