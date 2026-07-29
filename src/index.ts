import { Hono } from "hono";

export { GsvDeployWorkflow } from "./workflow";
export { DeployJobState } from "./deploy-job";

import { ALL_COMPONENTS, fetchReleaseOptions, findExistingGsvInstallations } from "./deploy";
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
import { deployPage, errorPage, homePage, jobPage, metricsPage, noAccountsPage } from "./pages";
import {
  fetchGsvSiteDaily,
  fetchMetricsByCountry,
  fetchMetricsByHour,
  fetchMetricsDaily,
  fetchMetricsSummary,
  fetchRecentDeploys,
  requestCountry,
  requireMetricsAuth,
  trackRequestEvent,
} from "./metrics";
import { fetchDailyHistory, fetchDeployTotals, fetchInstallList, rollupHistory } from "./history";
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
  if (session) return c.redirect("/deploy");
  return page(c, {
    title: "Deploy GSV",
    body: homePage(c.env.GITHUB_REPO_URL),
    canonicalPath: "/",
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
    options.accountId,
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
    // ?installs=all shows the internal account too; ?installs=public forces the
    // default filtered view. Either param keeps the (otherwise collapsed) list open.
    const installsParam = c.req.query("installs");
    const installsIncludeInternal = installsParam === "all";
    const installsExpanded = installsParam === "all" || installsParam === "public";
    // The install list and totals read from the D1 rollup tables, which the cron
    // only refreshes nightly — without this, deploys made since the last run show
    // under "Recent deploys" but are missing everywhere else. Fold the trailing
    // window in first (idempotent); best-effort so a rollup failure still renders
    // the page from the last good rollup.
    await rollupHistory(c.env, 2).catch((error) => {
      console.error(
        JSON.stringify({
          message: "On-view metrics rollup failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    const [summary, aeDaily, byCountry, byHour, recentDeploys, deployTotals, installs, history] = await Promise.all([
      fetchMetricsSummary(c.env),
      fetchMetricsDaily(c.env),
      fetchMetricsByCountry(c.env),
      fetchMetricsByHour(c.env),
      fetchRecentDeploys(c.env),
      fetchDeployTotals(c.env),
      fetchInstallList(c.env, installsIncludeInternal),
      fetchDailyHistory(c.env, 90),
    ]);
    // Durable rollups give the full funnel history; fall back to the 14-day AE
    // window until the first nightly rollup (or a backfill) has populated D1.
    const dailyFromHistory = history.length > 0;
    const daily = dailyFromHistory ? history : aeDaily;
    return page(c, {
      title: "Metrics",
      body: metricsPage(
        deployTotals,
        installs,
        installsIncludeInternal,
        installsExpanded,
        summary,
        daily,
        dailyFromHistory,
        byCountry,
        byHour,
        recentDeploys,
      ),
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

// One-time (or occasional) seed of the durable history tables from whatever
// Analytics Engine still retains. Behind the same auth as /metrics. Idempotent —
// safe to re-run. Example: curl -u user:pass -X POST '.../metrics/backfill?days=90'
app.post("/metrics/backfill", async (c) => {
  const denied = requireMetricsAuth(c);
  if (denied) return denied;
  const days = Number(c.req.query("days") ?? "90");
  try {
    const result = await rollupHistory(c.env, Number.isFinite(days) ? days : 90);
    return c.json({ ok: true, ...result });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502);
  }
});

// Machine-readable metrics for the traction spreadsheet collector. Same basic
// auth as /metrics. Web Analytics for gsv.space is best-effort: a failure there
// (e.g. token missing the RUM scope) is reported inline instead of failing the
// whole payload, so the deploy metrics keep flowing.
app.get("/metrics.json", async (c) => {
  const denied = requireMetricsAuth(c);
  if (denied) return denied;

  try {
    const [summary, daily] = await Promise.all([fetchMetricsSummary(c.env), fetchMetricsDaily(c.env)]);
    let gsvSite: Awaited<ReturnType<typeof fetchGsvSiteDaily>> | null = null;
    let gsvSiteError: string | undefined;
    try {
      gsvSite = await fetchGsvSiteDaily(c.env);
    } catch (error) {
      gsvSiteError = error instanceof Error ? error.message : String(error);
    }
    return c.json({ generatedAt: new Date().toISOString(), summary, daily, gsvSite, gsvSiteError });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 502);
  }
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/privacy", (c) =>
  page(c, {
    title: "Privacy",
    body: `<p class="eyebrow">Privacy</p><h1 class="page-title">Privacy</h1><p class="prose">This installer stores Cloudflare OAuth session data server-side only long enough to perform deployment. Sessions expire automatically from KV; deployment state and credentials expire from isolated Durable Object storage.</p>`,
    canonicalPath: "/privacy",
  }),
);

app.get("/terms", (c) =>
  page(c, {
    title: "Terms",
    body: `<p class="eyebrow">Terms</p><h1 class="page-title">Terms</h1><p class="prose">This installer is provided as-is. Review the requested Cloudflare OAuth scopes and deployed GSV release before authorizing deployment.</p>`,
    canonicalPath: "/terms",
  }),
);

app.get("/robots.txt", (c) =>
  c.text(
    [
      "User-agent: *",
      "Disallow: /login",
      "Disallow: /logout",
      "Disallow: /oauth/",
      "Disallow: /deploy",
      "Disallow: /jobs/",
      "Disallow: /api/",
      "Disallow: /metrics",
      "Allow: /",
      "",
      `Sitemap: ${c.env.APP_ORIGIN}/sitemap.xml`,
      "",
    ].join("\n"),
  ),
);

app.get("/sitemap.xml", (c) => {
  const urls = ["/", "/privacy", "/terms"]
    .map((path) => `  <url>\n    <loc>${c.env.APP_ORIGIN}${path}</loc>\n  </url>`)
    .join("\n");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } },
  );
});

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

export default {
  fetch: app.fetch,
  // Nightly cron: fold the last few days of Analytics Engine data into the durable
  // rollup tables. A trailing window (not just yesterday) absorbs late-arriving
  // events and covers the occasional missed run. Idempotent via INSERT OR REPLACE.
  scheduled(_event: ScheduledController, env: AppEnv["Bindings"], ctx: ExecutionContext): void {
    ctx.waitUntil(
      rollupHistory(env, 3).catch((error) => {
        console.error(
          JSON.stringify({
            message: "Metrics history rollup failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;
