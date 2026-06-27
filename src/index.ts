import { Hono } from "hono";

export { GsvDeployWorkflow } from "./workflow";

import { ALL_COMPONENTS, fetchReleaseOptions, findExistingGsvInstallations } from "./deploy";
import departureMonoWoff2 from "./assets/departure-mono.woff2";
import { appendLog, createJob, deleteDeployToken, failActiveJobStep, getJob, storeDeployToken, updateJob } from "./jobs";
import { page } from "./html";
import { fetchAccounts, getSessionWithId, handleCallback, logout, requireSession, startLogin } from "./oauth";
import { deployPage, errorPage, homePage, jobPage, noAccountsPage } from "./pages";
import type { AppEnv, DeployOptions } from "./types";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
});

app.get("/assets/departure-mono.woff2", () => {
  return new Response(departureMonoWoff2, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "font/woff2",
    },
  });
});

app.get("/", async (c) => {
  const session = await getSessionWithId(c);
  if (session) return c.redirect("/deploy");
  return page(c, {
    title: "Deploy GSV",
    body: homePage(c.env.GITHUB_REPO_URL),
  });
});

app.get("/login", (c) => startLogin(c));

app.get("/oauth/callback", (c) => handleCallback(c));

app.get("/logout", (c) => logout(c));

app.get("/deploy", async (c) => {
  let session;
  try {
    session = await requireSession(c);
  } catch {
    return c.redirect("/login");
  }

  const accounts = await fetchAccounts(session.session.token.access_token);
  const [releases, installations] = await Promise.all([
    fetchReleaseOptions(c.env).catch(() => []),
    findExistingGsvInstallations(session.session.token.access_token, accounts).catch(() => []),
  ]);
  return page(c, {
    title: "Deploy GSV",
    body: accounts.length > 0 ? deployPage(accounts, c.env.OAUTH_SCOPES, releases, installations) : noAccountsPage(),
    width: "wide",
  });
});

app.post("/deploy", async (c) => {
  let current;
  try {
    current = await requireSession(c);
  } catch {
    return c.redirect("/login");
  }

  const form = await c.req.formData();
  const accounts = await fetchAccounts(current.session.token.access_token);
  const existingTarget = parseExistingTarget(stringField(form, "target"));
  const accountId = existingTarget?.accountId ?? stringField(form, "accountId");
  const account = accounts.find((item) => item.id === accountId);
  if (!account) {
    return page(c, {
      title: "Invalid Account",
      body: errorPage("Invalid Account", "The selected Cloudflare account was not authorized for this OAuth session."),
      status: 400,
    });
  }

  const components = form.getAll("component").map(String).filter((value) => ALL_COMPONENTS.includes(value as (typeof ALL_COMPONENTS)[number]));
  const options: DeployOptions = {
    accountId,
    accountName: account.name,
    instance: (existingTarget?.instance ?? stringField(form, "instance")) || "gsv",
    version: stringField(form, "version") || "latest",
    components: components.length > 0 ? components : [...ALL_COMPONENTS],
    discordBotToken: optionalStringField(form, "discordBotToken"),
    telegramBotToken: optionalStringField(form, "telegramBotToken"),
  };

  const job = await createJob(c.env, current.sessionId, options);
  await storeDeployToken(c.env, job.id, current.session.token.access_token);
  try {
    const instance = await c.env.DEPLOY_WORKFLOW.create({
      id: job.id,
      params: { jobId: job.id },
      retention: {
        successRetention: "1 day",
        errorRetention: "7 days",
      },
    });
    await appendLog(c.env, job.id, "info", `Started deployment workflow ${instance.id}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deleteDeployToken(c.env, job.id);
    await failActiveJobStep(c.env, job.id, "The deployment workflow could not start. Retry the deployment in a moment.");
    await appendLog(c.env, job.id, "error", `Failed to start deployment workflow: ${message}`);
    await updateJob(c.env, job.id, { status: "failed", error: message });
  }
  return c.redirect(`/jobs/${job.id}`);
});

app.get("/jobs/:id", async (c) => {
  let current;
  try {
    current = await requireSession(c);
  } catch {
    return c.redirect("/login");
  }

  const job = await getJob(c.env, c.req.param("id"));
  if (!job || job.sessionId !== current.sessionId) {
    return page(c, {
      title: "Not Found",
      body: errorPage("Not Found", "Deployment job was not found."),
      status: 404,
    });
  }

  return page(c, {
    title: `Deploy ${job.options.instance}`,
    body: jobPage(job),
    width: "wide",
    refreshSeconds: job.status === "queued" || job.status === "running" ? 4 : undefined,
  });
});

app.get("/api/jobs/:id", async (c) => {
  const current = await getSessionWithId(c);
  if (!current) return c.json({ error: "Authentication required" }, 401);

  const job = await getJob(c.env, c.req.param("id"));
  if (!job || job.sessionId !== current.sessionId) return c.json({ error: "Not found" }, 404);
  return c.json(job);
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/privacy", (c) =>
  page(c, {
    title: "Privacy",
    body: `<p class="eyebrow">Privacy</p><h1 class="page-title">Privacy</h1><p class="prose">This installer stores Cloudflare OAuth session data server-side only long enough to perform deployment. Session and job data expire automatically from KV.</p>`,
  }),
);

app.get("/terms", (c) =>
  page(c, {
    title: "Terms",
    body: `<p class="eyebrow">Terms</p><h1 class="page-title">Terms</h1><p class="prose">This installer is provided as-is. Review the requested Cloudflare OAuth scopes and deployed GSV release before authorizing deployment.</p>`,
  }),
);

app.notFound((c) =>
  page(c, {
    title: "Not Found",
    body: errorPage("Not Found", "That route does not exist."),
    status: 404,
  }),
);

function stringField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function optionalStringField(form: FormData, name: string): string | undefined {
  const value = stringField(form, name);
  return value || undefined;
}

function parseExistingTarget(value: string): { accountId: string; instance: string } | null {
  const parts = value.split("|");
  if (parts.length !== 3 || parts[0] !== "existing") return null;
  const accountId = parts[1]?.trim();
  const instance = parts[2]?.trim();
  return accountId && instance ? { accountId, instance } : null;
}

export default app;
