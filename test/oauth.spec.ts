import { describe, expect, it, vi } from "vitest";

import { safeOAuthReturnPath, startLogin } from "../src/oauth";

describe("OAuth return paths", () => {
  it("preserves supported in-app destinations and query strings", () => {
    expect(safeOAuthReturnPath("/deploy?update=1&instance=gsv-work")).toBe(
      "/deploy?update=1&instance=gsv-work",
    );
    expect(safeOAuthReturnPath("/manage/delete?accountId=abc&instance=gsv")).toBe(
      "/manage/delete?accountId=abc&instance=gsv",
    );
    expect(safeOAuthReturnPath("/jobs/job_123?submitted=1")).toBe("/jobs/job_123?submitted=1");
  });

  it("falls back to the overview for external or unsupported destinations", () => {
    for (const value of [
      undefined,
      "https://example.com/deploy",
      "//example.com/deploy",
      "/\\example.com/deploy",
      "/oauth/callback",
      "/deploy#fragment",
    ]) {
      expect(safeOAuthReturnPath(value)).toBe("/manage");
    }
  });

  it("binds the validated return path to server-side OAuth state", async () => {
    const put = vi.fn(async () => undefined);
    const context = {
      env: {
        APP_ORIGIN: "https://deploy.gsv.space",
        CF_OAUTH_CLIENT_ID: "client-id",
        OAUTH_SCOPES: "workers-scripts.write",
        SESSIONS: { put },
      },
      req: {
        query: (name: string) => name === "returnTo" ? "/deploy?update=1&instance=gsv-work" : undefined,
      },
    } as unknown as Parameters<typeof startLogin>[0];

    const response = await startLogin(context);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("https://dash.cloudflare.com/oauth2/auth");
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^oauth-state:/),
      "/deploy?update=1&instance=gsv-work",
      { expirationTtl: 600 },
    );
  });
});
