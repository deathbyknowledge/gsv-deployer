import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("protected routes", () => {
  it("keeps local page previews unavailable in production", async () => {
    const response = await SELF.fetch("https://deploy.gsv.space/preview/manage");

    expect(response.status).toBe(404);
  });

  it("redirects unauthenticated management requests to OAuth", async () => {
    const response = await SELF.fetch("https://deploy.gsv.space/manage", {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?returnTo=%2Fmanage");
  });
});
