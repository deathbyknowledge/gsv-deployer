import { Hono } from "hono";

export { GsvDeployWorkflow } from "./workflow";
export { DeployJobState } from "./deploy-job";

import { ALL_COMPONENTS, deleteGsvInstallation, fetchReleaseOptions, findExistingGsvInstallations } from "./deploy";
import departureMonoWoff2 from "./assets/departure-mono.woff2";
import { ANALYTICS_SCRIPT } from "./analytics";
import {
  appendLog,
  createJob,
  getJob,
  JOB_TTL_SECONDS,
  markJobStartFailure,
  toPublicDeployJob,
  verifyJobViewToken,
} from "./jobs";
import { getCookie, setCookie } from "./cookies";
import { page } from "./html";
import { fetchAccounts, getSessionWithId, handleCallback, logout, requireSession, startLogin } from "./oauth";
import { confirmDeletePage, deployPage, errorPage, homePage, jobPage, managePage, metricsPage, noAccountsPage } from "./pages";
import type { DeployPrefill } from "./pages";
import {
  fetchMetricsByCountry,
  fetchMetricsByHour,
  fetchMetricsDaily,
  fetchMetricsSummary,
  fetchRecentDeploys,
  requestCountry,
  requireMetricsAuth,
  trackRequestEvent,
} from "./metrics";
import type { AppEnv, DeployAdapterSecrets, DeployJob, DeployOptions } from "./types";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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

app.get("/assets/analytics.js", () => {
  return new Response(ANALYTICS_SCRIPT, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/javascript; charset=utf-8",
    },
  });
});

app.get("/", async (c) => {
  const session = await getSessionWithId(c);
  if (session) return c.redirect("/manage");
  return page(c, {
    title: "Deploy GSV",
    body: homePage(c.env.GITHUB_REPO_URL),
  });
});

app.get("/login", (c) => {
  const referer = c.req.header("referer") ?? "";
  const isSessionExpiredRedirect = referer.includes("/deploy") || referer.includes("/jobs/") || referer.includes("/manage");
  trackRequestEvent(c.env, c.req.raw, "login_view", isSessionExpiredRedirect ? "session_expired" : "cta", requestCountry(c.req.raw));
  return startLogin(c);
});

app.get("/oauth/callback", (c) => handleCallback(c));

app.get("/logout", (c) => logout(c));

app.get("/manage", async (c) => {
  let session;
  try {
    session = await requireSession(c);
  } catch {
    return c.redirect("/login");
  }

  const accounts = await fetchAccounts(session.session.token.access_token);
  const installations = await findExistingGsvInstallations(session.session.token.access_token, accounts).catch(() => []);
  // The overview is always the landing page after login, including the empty
  // state that points first-time users at the deploy form.
  return page(c, {
    title: "Your GSVs",
    body: managePage(installations),
    width: "wide",
  });
});

app.get("/manage/delete", async (c) => {
  let session;
  try {
    session = await requireSession(c);
  } catch {
    return c.redirect("/login");
  }

  const accountId = c.req.query("accountId") ?? "";
  const instance = c.req.query("instance") ?? "";
  const accounts = await fetchAccounts(session.session.token.access_token);
  const installations = await findExistingGsvInstallations(session.session.token.access_token, accounts).catch(() => []);
  const install = installations.find((item) => item.accountId === accountId && item.instance === instance);
  if (!install) return c.redirect("/manage");

  return page(c, {
    title: `Delete ${install.instance}`,
    body: confirmDeletePage(install),
    width: "wide",
  });
});

app.post("/manage/delete", async (c) => {
  let session;
  try {
    session = await requireSession(c);
  } catch {
    return c.redirect("/login");
  }

  const form = await c.req.formData();
  const accountId = stringField(form, "accountId");
  const instance = stringField(form, "instance");
  const accounts = await fetchAccounts(session.session.token.access_token);
  // Re-detect server-side so we only ever delete Worker scripts that belong to a
  // GSV install in one of this session's authorized accounts.
  const installations = await findExistingGsvInstallations(session.session.token.access_token, accounts).catch(() => []);
  const install = installations.find((item) => item.accountId === accountId && item.instance === instance);
  if (!install) return c.redirect("/manage");

  const deleteStorage = stringField(form, "deleteStorage") === "1";
  const result = await deleteGsvInstallation(session.session.token.access_token, install, { deleteStorage });
  if (result.failed.length > 0) {
    const scripts = result.failed.map((entry) => entry.script).join(", ");
    return page(c, {
      title: "Delete failed",
      body: errorPage(
        "Could not fully delete",
        `Some Workers for ${install.instance} could not be deleted (${scripts}): ${result.failed[0].error}. Any remaining Workers are shown back on your GSVs overview.`,
      ),
      status: 502,
    });
  }
  if (result.storage && !result.storage.deleted) {
    return page(c, {
      title: "Storage not deleted",
      body: errorPage(
        "Workers deleted, storage kept",
        `The Workers for ${install.instance} were deleted, but the R2 bucket ${result.storage.name} could not be removed: ${result.storage.error}. If it still contains files, empty it in the Cloudflare dashboard and delete the bucket there.`,
      ),
      status: 502,
    });
  }
  return c.redirect("/manage");
});

app.get("/deploy", async (c) => {
  let session;
  try {
    session = await requireSession(c);
  } catch {
    return c.redirect("/login");
  }

  const accounts = await fetchAccounts(session.session.token.access_token);
  trackRequestEvent(c.env, c.req.raw, "deploy_view", accounts.length > 0 ? "has_accounts" : "no_accounts", requestCountry(c.req.raw));
  const [releases, installations] = await Promise.all([
    fetchReleaseOptions(c.env).catch(() => []),
    findExistingGsvInstallations(session.session.token.access_token, accounts).catch(() => []),
  ]);
  const prefill = parseDeployPrefill(c.req.query());
  return page(c, {
    title: "Deploy GSV",
    body: accounts.length > 0 ? deployPage(accounts, c.env.OAUTH_SCOPES, releases, installations, prefill) : noAccountsPage(),
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
  };
  const adapterSecrets: DeployAdapterSecrets = {
    discordBotToken: optionalStringField(form, "discordBotToken"),
    telegramBotToken: optionalStringField(form, "telegramBotToken"),
  };

  const { job, viewToken } = await createJob(c.env, {
    sessionId: current.sessionId,
    options,
    token: current.session.token,
    tokenIssuedAt: sessionCreatedAtMs(current.session.createdAt),
    adapterSecrets,
  });
  trackRequestEvent(
    c.env,
    c.req.raw,
    "deploy_submit",
    options.version,
    requestCountry(c.req.raw),
    job.id,
    options.instance,
    options.accountName || options.accountId,
  );
  try {
    const instance = await c.env.DEPLOY_WORKFLOW.create({
      id: job.id,
      params: { jobId: job.id },
      retention: {
        successRetention: "1 day",
        errorRetention: "7 days",
      },
    });
    try {
      await appendLog(c.env, job.id, "info", `Started deployment workflow ${instance.id}.`);
    } catch (error) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        jobId: job.id,
        message: "Could not append workflow startup diagnostic",
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobStartFailure(
      c.env,
      job.id,
      "The deployment workflow could not start. Retry the deployment in a moment.",
      message,
    );
  }
  // `?submitted=1` signals the job page to fire the one-time deploy_submit event.
  return redirectWithCookies(`/jobs/${job.id}?submitted=1`, [
    setCookie(jobViewCookieName(job.id), viewToken, JOB_TTL_SECONDS),
  ]);
});

app.get("/jobs/:id", async (c) => {
  const job = await getJob(c.env, c.req.param("id"));
  if (!job) {
    return page(c, {
      title: "Not Found",
      body: errorPage("Not Found", "Deployment job was not found."),
      status: 404,
    });
  }

  const current = await getSessionWithId(c);
  const canView = await canViewJob(c.req.raw, job, current?.sessionId);
  if (!canView) {
    if (!current) return c.redirect("/login");
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
  return c.json(toPublicDeployJob(job));
});

app.get("/metrics", async (c) => {
  const denied = requireMetricsAuth(c);
  if (denied) return denied;

  try {
    const [summary, daily, byCountry, byHour, recentDeploys] = await Promise.all([
      fetchMetricsSummary(c.env),
      fetchMetricsDaily(c.env),
      fetchMetricsByCountry(c.env),
      fetchMetricsByHour(c.env),
      fetchRecentDeploys(c.env),
    ]);
    return page(c, {
      title: "Metrics",
      body: metricsPage(summary, daily, byCountry, byHour, recentDeploys),
      width: "wide",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return page(c, {
      title: "Metrics",
      body: errorPage("Metrics unavailable", message),
      status: 502,
    });
  }
});

app.get("/health", (c) => c.json({ ok: true }));

// Auth-free page previews for local review. Enabled only when ENVIRONMENT is
// "development" (set by the `dev` npm script); returns 404 in production.
app.get("/preview/:kind", (c) => {
  if (c.env.ENVIRONMENT !== "development") {
    return page(c, {
      title: "Not Found",
      body: errorPage("Not Found", "That route does not exist."),
      status: 404,
    });
  }
  const kind = c.req.param("kind");
  const previewInstalls = [
    { accountId: "acc1", accountName: "My Cloudflare", instance: "gsv", components: ["gateway", "ripgit", "assembler"], scriptNames: [] },
    { accountId: "acc2", accountName: "Other account", instance: "gsv-work", components: ["gateway", "ripgit", "assembler", "channel-discord"], scriptNames: [] },
  ];
  if (kind === "manage") {
    return page(c, { title: "Your GSVs", body: managePage(previewInstalls), width: "wide" });
  }
  if (kind === "manage-empty") {
    return page(c, { title: "Your GSVs", body: managePage([]), width: "wide" });
  }
  if (kind === "delete") {
    return page(c, {
      title: "Delete gsv-work",
      body: confirmDeletePage({
        accountId: "acc2",
        accountName: "Other account",
        instance: "gsv-work",
        components: ["gateway", "ripgit", "assembler", "channel-discord"],
        scriptNames: ["gsv-work", "gsv-work-ripgit", "gsv-work-assembler", "gsv-work-channel-discord"],
      }),
      width: "wide",
    });
  }
  if (kind === "update-form") {
    return page(c, {
      title: "Deploy GSV",
      body: deployPage(
        [
          { id: "acc1", name: "My Cloudflare" },
          { id: "acc2", name: "Other account" },
        ] as unknown as Parameters<typeof deployPage>[0],
        c.env.OAUTH_SCOPES,
        [],
        previewInstalls,
        { mode: "update", accountId: "acc2", instance: "gsv-work", components: ["gateway", "ripgit", "assembler", "channel-discord"] },
      ),
      width: "wide",
    });
  }
  if (kind === "retry-form") {
    return page(c, {
      title: "Deploy GSV",
      body: deployPage(
        [
          { id: "acc1", name: "My Cloudflare" },
          { id: "acc2", name: "Other account" },
        ] as unknown as Parameters<typeof deployPage>[0],
        c.env.OAUTH_SCOPES,
        [],
        [],
        { accountId: "acc2", instance: "gsv-personal", version: "latest", components: ["gateway", "ripgit"] },
      ),
      width: "wide",
    });
  }
  const now = Date.now();
  if (kind === "success") {
    const successJob: DeployJob = {
      id: "job_preview_ok",
      sessionId: "preview",
      status: "succeeded",
      createdAt: now,
      updatedAt: now,
      options: {
        accountId: "acc1",
        accountName: "My Cloudflare",
        instance: "gsv",
        version: "latest",
        components: ["gateway", "ripgit", "assembler", "channel-discord"],
      },
      steps: [
        { id: "authorize", title: "Authorize Cloudflare", description: "Confirm access.", status: "complete", detail: "Authorized My Cloudflare." },
        { id: "release", title: "Choose GSV release", description: "Find the release.", status: "complete" },
        { id: "prepare", title: "Prepare components", description: "Download and verify.", status: "complete" },
        { id: "storage", title: "Create storage", description: "Set up storage resources.", status: "complete" },
        { id: "workers", title: "Deploy Workers", description: "Upload Workers.", status: "complete" },
        { id: "bindings", title: "Connect services", description: "Wire Workers together.", status: "complete" },
        { id: "adapters", title: "Configure channels", description: "Apply channel settings.", status: "complete" },
        { id: "finish", title: "Finish setup", description: "Confirm result.", status: "complete" },
      ],
      logs: [
        { at: now, level: "info", message: "Queued deployment." },
        { at: now, level: "info", message: "Deployment complete." },
      ],
      result: { version: "latest", gatewayUrl: "https://gsv.example.workers.dev" },
    };
    return page(c, { title: "Deploy gsv", body: jobPage(successJob), width: "wide" });
  }
  const error = kind === "selffix" ? "latest stable release not found" : "kv namespace could not be created";
  const job: DeployJob = {
    id: "job_preview_abc123",
    sessionId: "preview",
    status: "failed",
    createdAt: now,
    updatedAt: now,
    options: {
      accountId: "acc1",
      accountName: "My Cloudflare",
      instance: "gsv",
      version: "latest",
      components: ["gateway", "ripgit", "assembler", "channel-discord"],
    },
    steps: [
      { id: "authorize", title: "Authorize Cloudflare", description: "Confirm access.", status: "complete", detail: "Authorized My Cloudflare." },
      { id: "release", title: "Choose GSV release", description: "Find the release.", status: "complete" },
      { id: "prepare", title: "Prepare components", description: "Download and verify.", status: "complete" },
      { id: "storage", title: "Create storage", description: "Set up storage resources.", status: "failed" },
      { id: "workers", title: "Deploy Workers", description: "Upload Workers.", status: "pending" },
      { id: "finish", title: "Finish setup", description: "Confirm result.", status: "pending" },
    ],
    logs: [
      { at: now, level: "info", message: "Queued deployment." },
      { at: now, level: "info", message: "Prepared components." },
      { at: now, level: "error", message: error },
    ],
    error,
  };
  return page(c, { title: "Deploy gsv", body: jobPage(job), width: "wide" });
});

app.get("/privacy", (c) =>
  page(c, {
    title: "Privacy",
    body: `<p class="eyebrow">Privacy</p><h1 class="page-title">Privacy</h1><p class="prose">This installer stores Cloudflare OAuth session data server-side only long enough to perform deployment. Sessions expire automatically from KV; deployment state and credentials expire from isolated Durable Object storage.</p>`,
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

function parseDeployPrefill(query: Record<string, string>): DeployPrefill | undefined {
  const mode = query.update === "1" ? "update" : query.retry === "1" ? "retry" : undefined;
  if (!mode) return undefined;
  const components = query.components
    ? query.components
        .split(",")
        .map((value) => value.trim())
        .filter((value) => ALL_COMPONENTS.includes(value as (typeof ALL_COMPONENTS)[number]))
    : undefined;
  return {
    mode,
    accountId: query.accountId || undefined,
    instance: query.instance || undefined,
    version: query.version || undefined,
    components: components && components.length > 0 ? components : undefined,
  };
}

function parseExistingTarget(value: string): { accountId: string; instance: string } | null {
  const parts = value.split("|");
  if (parts.length !== 3 || parts[0] !== "existing") return null;
  const accountId = parts[1]?.trim();
  const instance = parts[2]?.trim();
  return accountId && instance ? { accountId, instance } : null;
}

async function canViewJob(request: Request, job: DeployJob, sessionId?: string): Promise<boolean> {
  if (sessionId && job.sessionId === sessionId) return true;
  return verifyJobViewToken(job, getCookie(request, jobViewCookieName(job.id)));
}

function jobViewCookieName(jobId: string): string {
  return `gsv_deploy_job_${jobId}`;
}

function sessionCreatedAtMs(createdAt: string): number | undefined {
  const value = Date.parse(createdAt);
  return Number.isFinite(value) ? value : undefined;
}

function redirectWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export default app;
