import { Hono } from "hono";

export { GsvDeployWorkflow } from "./workflow";

import { ALL_COMPONENTS, fetchReleaseOptions, findExistingGsvInstallations } from "./deploy";
import departureMonoWoff2 from "./assets/departure-mono.woff2";
import { ANALYTICS_SCRIPT } from "./analytics";
import {
  appendLog,
  createJob,
  deleteDeployToken,
  failActiveJobStep,
  getJob,
  JOB_TTL_SECONDS,
  storeDeployToken,
  updateJob,
  verifyJobViewToken,
} from "./jobs";
import { getCookie, setCookie } from "./cookies";
import { page } from "./html";
import { fetchAccounts, getSessionWithId, handleCallback, logout, requireSession, startLogin } from "./oauth";
import { deployPage, errorPage, homePage, jobPage, metricsPage, noAccountsPage } from "./pages";
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
import type { AppEnv, DeployJob, DeployOptions } from "./types";

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
  if (session) return c.redirect("/deploy");
  return page(c, {
    title: "Deploy GSV",
    body: homePage(c.env.GITHUB_REPO_URL),
  });
});

app.get("/login", (c) => {
  const referer = c.req.header("referer") ?? "";
  const isSessionExpiredRedirect = referer.includes("/deploy") || referer.includes("/jobs/");
  trackRequestEvent(c.env, c.req.raw, "login_view", isSessionExpiredRedirect ? "session_expired" : "cta", requestCountry(c.req.raw));
  return startLogin(c);
});

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
  trackRequestEvent(c.env, c.req.raw, "deploy_view", accounts.length > 0 ? "has_accounts" : "no_accounts", requestCountry(c.req.raw));
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

  const { job, viewToken } = await createJob(c.env, current.sessionId, options);
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
  await storeDeployToken(c.env, job.id, current.session.token, sessionCreatedAtMs(current.session.createdAt));
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
  return c.json(job);
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
