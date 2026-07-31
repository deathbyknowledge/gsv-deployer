import type { Account, DeployJob } from "./types";
import { storageBucketNameForInstance } from "./deploy";
import type { ExistingGsvInstallation, ReleaseOption } from "./deploy";
import { getDeployHelp } from "./deploy-help";
import { cloudflareMark, discordIcon, escapeHtml, octocatIcon, xIcon } from "./html";
import type { MetricsCountryRow, MetricsDailyRow, MetricsHourRow, MetricsRecentDeployRow, MetricsSummaryRow } from "./metrics";
import type { DeployTotals, InstallRow } from "./history";

const HELP_DISCORD_URL = "https://discord.gg/hy9ExJJFvn";

export function homePage(repoUrl: string): string {
  return `<section class="home-sheet">
  <header class="home-masthead">
    <a href="https://gsv.space">gsv.space</a>
    <div class="masthead-links">
      <a href="https://docs.gsv.space">Docs</a>
      <a href="${escapeHtml(repoUrl)}" aria-label="GitHub">${octocatIcon()}</a>
      <a href="https://discord.gg/hy9ExJJFvn" aria-label="Discord">${discordIcon()}</a>
      <a href="https://x.com/gsvspace" aria-label="X">${xIcon()}</a>
    </div>
  </header>
  <div class="home-intro">
    <article class="home-copy">
      <p class="home-label">GSV on Cloudflare</p>
      <h1>Deploy GSV to your Cloudflare account</h1>
      <p class="lede">Your personal AI computer, running on infrastructure you control.</p>
      <p class="prose">This installer connects directly to Cloudflare and deploys GSV into your account. Your Workers, data, and credentials stay yours.</p>
      <div class="actions">
        <a class="button" href="/login">Continue with Cloudflare</a>
        <a class="link-button" href="https://docs.gsv.space/get-started/">Read the guide</a>
      </div>
    </article>
    <div class="home-side">
      <p class="manifest-intro">Before you start</p>
      <dl class="home-facts" aria-label="Cloudflare requirements">
        <div><dt>Plan</dt><dd>Workers Free is supported. Workers Paid adds CodeMode and more CPU.</dd></div>
        <div><dt>Storage</dt><dd>R2 object storage must be enabled in the account you choose.</dd></div>
        <div><dt>Models</dt><dd>Connect your preferred model provider during GSV setup.</dd></div>
      </dl>
    </div>
  </div>
</section>
<section class="home-steps" aria-label="Deployment steps">
  <div><span>01</span><strong>Connect Cloudflare</strong><p>Authorize only the access the installer needs.</p></div>
  <div><span>02</span><strong>Deploy GSV</strong><p>Choose an account and let the installer handle the complete stack.</p></div>
  <div><span>03</span><strong>Finish setup</strong><p>Open your GSV, create your user, and connect a model.</p></div>
</section>`;
}

export type DeployPrefill = {
  mode?: "retry" | "update";
  accountId?: string;
  instance?: string;
  version?: string;
};

export function deployPage(
  accounts: Account[],
  scopes: string,
  releases: ReleaseOption[],
  installations: ExistingGsvInstallation[],
  prefill?: DeployPrefill,
): string {
  const accountOptions = accounts
    .map(
      (account) =>
        `<option value="${escapeHtml(account.id)}"${account.id === prefill?.accountId ? " selected" : ""}>${escapeHtml(displayAccount(account))}</option>`,
    )
    .join("");
  const isUpdate = Boolean(prefill?.mode === "update" && prefill.accountId && prefill.instance);

  // The "new install name" field only applies to a new target; it is hidden when
  // updating an existing install (its name is fixed by the chosen target).
  const instanceValue = (!isUpdate && prefill?.instance) || "gsv";
  const advancedOpen =
    prefill?.mode === "retry" || instanceValue !== "gsv" || (prefill?.version && prefill.version !== "latest")
      ? " open"
      : "";
  const note = isUpdate
    ? ""
    : prefill
      ? `<p class="prose retry-note">Retrying your last deployment. Review the settings below and deploy again.</p>`
      : "";

  // In update mode the target is fixed and carried in a hidden field so the
  // redeploy updates the install in place. New installs pick a Cloudflare account.
  const targetSection = isUpdate
    ? (() => {
        const accountName =
          installations.find(
            (install) => install.accountId === prefill?.accountId && install.instance === prefill?.instance,
          )?.accountName ?? prefill?.accountId ?? "";
        return `<input type="hidden" name="target" value="existing|${escapeHtml(prefill!.accountId!)}|${escapeHtml(prefill!.instance!)}">
    <div class="target-summary">
      <span class="hint">Updating in ${escapeHtml(accountName)}</span>
      <strong>${escapeHtml(prefill!.instance!)}</strong>
    </div>`;
      })()
    : `<label class="target-field-full">
      Cloudflare account
      <select name="accountId" required>${accountOptions}</select>
      <span class="hint">Where this new GSV will be deployed.</span>
    </label>`;

  const heading = isUpdate ? `Update ${escapeHtml(prefill!.instance!)}` : "Deploy a new GSV";
  const intro = isUpdate
    ? "Apply a release to the complete GSV installation. Your files and settings stay in place."
    : "Choose the Cloudflare account where your GSV should live. The installer handles the complete stack.";
  const installOptions = isUpdate
    ? ""
    : `<label>
      Install name
      <input name="instance" value="${escapeHtml(instanceValue)}" pattern="[a-z0-9-]+" autocomplete="off" required>
      <span class="hint">Pick a unique name such as gsv-personal when running multiple GSVs in one account.</span>
    </label>
    <div class="panel scope-panel">
      <strong>What this installer can access</strong>
      <p class="hint">Cloudflare OAuth permissions you granted at login.</p>
      <ul class="scope-list">${renderScopeList(scopes)}</ul>
    </div>`;
  const advancedSection = `<details class="advanced"${advancedOpen}>
    <summary>Advanced options</summary>
    <label>
      Release
      <select name="version" required>${renderReleaseOptions(releases, prefill?.version)}</select>
      <span class="hint">Use latest stable unless you need a specific release.</span>
    </label>
    ${installOptions}
  </details>`;
  const submitLabel = isUpdate ? `Update ${escapeHtml(prefill!.instance!)}` : "Deploy";

  return `<p class="eyebrow"><a href="/manage">Your GSVs</a> / <a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} ${heading}</h1>
<p class="prose">${intro}</p>
${note}
<form class="section form-grid" method="post" action="/deploy">
  <div>
    <h2>${isUpdate ? "GSV" : "Where"}</h2>
    ${targetSection}
  </div>
  ${advancedSection}
  <div class="actions left">
    <button class="button" type="submit">${submitLabel}</button>
    <a class="link-button" href="/manage">Cancel</a>
  </div>
</form>`;
}

function manageUpdateHref(install: ExistingGsvInstallation): string {
  const params = new URLSearchParams({
    update: "1",
    accountId: install.accountId,
    instance: install.instance,
  });
  return `/deploy?${params.toString()}`;
}

function manageDeleteHref(install: ExistingGsvInstallation): string {
  const params = new URLSearchParams({
    accountId: install.accountId,
    instance: install.instance,
  });
  return `/manage/delete?${params.toString()}`;
}

export function managePage(installations: ExistingGsvInstallation[]): string {
  const cards = installations
    .map(
      (install) => `<article class="manage-card">
  <div class="manage-card-head">
    <div>
      <strong>${escapeHtml(install.instance)}</strong>
      <span class="hint">${escapeHtml(install.accountName)}</span>
    </div>
    <span class="install-status ${install.deleteSupported ? "managed" : "unverified"}">${install.deleteSupported ? "Managed install" : "Unverified install"}</span>
  </div>
  ${install.deleteSupported ? `<p class="hint">Ready to update or remove from this installer.</p>` : `<p class="hint">These Workers match GSV's older names, but their management tags don't verify ownership. This may be a legacy GSV installation or a name collision. Verify them in Cloudflare before updating or removing anything. Deletion stays disabled here.</p>`}
  <div class="actions left">
    <a class="link-button" href="${escapeHtml(manageUpdateHref(install))}">Update</a>
    ${install.deleteSupported ? `<a class="link-button danger" href="${escapeHtml(manageDeleteHref(install))}">Delete</a>` : ""}
  </div>
</article>`,
    )
    .join("");

  return `<p class="eyebrow"><a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} Manage your existing GSVs</h1>
<section class="section manage-section">
  ${installations.length > 0 ? `<p class="prose">Update an installation or remove one whose ownership GSV can verify.</p><div class="manage-grid">${cards}</div>` : `<div class="empty-state"><strong>No GSVs found</strong><p>There aren't any GSV installations in your connected Cloudflare accounts yet.</p></div>`}
</section>
<section class="section new-gsv-panel">
  <div>
    <h2>Want to deploy a new one?</h2>
    <p>Choose a Cloudflare account and the installer will set up the complete GSV stack.</p>
  </div>
  <a class="button" href="/deploy">Deploy a new GSV</a>
</section>`;
}

export function confirmDeletePage(install: ExistingGsvInstallation): string {
  const scripts = install.scriptNames;
  const bucketName = storageBucketNameForInstance(install.instance);
  return `<p class="eyebrow"><a href="/manage">Your GSVs</a> / <a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} Delete ${escapeHtml(install.instance)}</h1>
<p class="prose">Remove <strong>${escapeHtml(install.instance)}</strong> from <strong>${escapeHtml(install.accountName)}</strong>. Your files stay in R2 by default, so you can redeploy later without losing them.</p>
<section class="section danger-zone">
  <div class="delete-outcomes">
    <div><span class="outcome-label remove">Will be removed</span><strong>GSV and its connected services</strong><p>The Cloudflare Workers that run this installation.</p></div>
    <div><span class="outcome-label keep">Will be kept</span><strong>Your files and storage</strong><p>The R2 bucket <code>${escapeHtml(bucketName)}</code> and anything stored in it.</p></div>
  </div>
  <form method="post" action="/manage/delete">
    <input type="hidden" name="accountId" value="${escapeHtml(install.accountId)}">
    <input type="hidden" name="instance" value="${escapeHtml(install.instance)}">
    <label class="check-row danger-check">
      <input type="checkbox" name="deleteStorage" value="1">
      <span>
        <strong>Also remove the storage bucket if it is empty</strong>
        <span class="hint">Cloudflare only removes an empty R2 bucket. This does not delete files; if the bucket contains anything, it will be kept.</span>
      </span>
    </label>
    <details class="technical-details">
      <summary>Technical details</summary>
      <p class="hint">Worker IDs that this installer will remove:</p>
      <ul class="lean-list script-list">${scripts.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join("")}</ul>
    </details>
    <div class="actions left">
      <button class="button danger" type="submit">Delete ${escapeHtml(install.instance)}</button>
      <a class="link-button" href="/manage">Cancel</a>
    </div>
  </form>
</section>`;
}

export function noAccountsPage(): string {
  return `<p class="eyebrow"><a href="/logout">Log out</a></p>
<h1 class="page-title">No Accounts</h1>
<p class="prose">Cloudflare did not return an authorized account. Log out and authorize at least one account for this installer.</p>
<div class="actions left"><a class="button" href="/logout">Log out</a></div>`;
}

export function jobPage(job: DeployJob): string {
  const progress = progressSummary(job);
  const log = job.logs
    .map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString();
      const cls = entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "";
      return `<span class="${cls}">[${escapeHtml(time)}] ${escapeHtml(entry.message)}</span>`;
    })
    .join("\n");
  const gateway = job.result?.gatewayUrl
    ? `<div class="actions left"><a class="button" href="${escapeHtml(job.result.gatewayUrl)}">Go to your GSV</a><a class="link-button" href="/deploy">Deploy another</a></div>`
    : "";
  const help = job.status === "failed" ? failureHelp(job) : "";

  return `<p class="eyebrow"><a href="/deploy">Deploy</a> / <a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} ${escapeHtml(job.options.instance)}</h1>
<section class="progress-banner ${progress.tone}">
  <span class="status-pill">${escapeHtml(progress.label)}</span>
  <h2>${escapeHtml(progress.title)}</h2>
  <p>${escapeHtml(progress.message)}</p>
</section>
${help}
<section class="section">
  <h2>Progress</h2>
  <ol class="stepper">${renderSteps(job)}</ol>
</section>
<section class="section">
  <h2>Target</h2>
  <ul class="lean-list">
    <li><strong>Account</strong><span class="detail">${escapeHtml(job.options.accountName || job.options.accountId)}</span></li>
    <li><strong>Release</strong><span class="detail">${escapeHtml(job.result?.version || job.options.version)}</span></li>
  </ul>
</section>
${gateway}
<section class="section">
  <details class="diagnostics"${job.status === "failed" ? " open" : ""}>
    <summary>Deployment details</summary>
    <pre class="log">${log || "Waiting for logs..."}</pre>
  </details>
</section>
<div id="gsv-analytics" data-job-id="${escapeHtml(job.id)}" data-release="${escapeHtml(job.options.version)}" data-status="${escapeHtml(job.status)}" hidden></div>
<script src="/assets/analytics.js"></script>`;
}

function retryDeployHref(job: DeployJob): string {
  const params = new URLSearchParams({
    retry: "1",
    accountId: job.options.accountId,
    instance: job.options.instance,
    version: job.options.version,
  });
  return `/deploy?${params.toString()}`;
}

function failureHelp(job: DeployJob): string {
  const help = getDeployHelp(job.error ?? "");
  const report =
    help.bucket === "bug"
      ? `<p class="hint help-report">Still stuck? <a href="${HELP_DISCORD_URL}">Ask on Discord</a> and include the deployment ID <code>${escapeHtml(job.id)}</code>.</p>`
      : "";
  return `<section class="section deploy-help">
  <h2>What to do next</h2>
  <p class="prose">${escapeHtml(help.whatToDo)}</p>
  <div class="actions left">
    <a class="button" href="${escapeHtml(retryDeployHref(job))}">Retry deployment</a>
  </div>
  ${report}
</section>`;
}

export function errorPage(title: string, message: string): string {
  return `<p class="eyebrow"><a href="/">Home</a></p>
<h1 class="page-title">${escapeHtml(title)}</h1>
<p class="prose">${escapeHtml(message)}</p>`;
}

export function metricsPage(
  deployTotals: DeployTotals,
  installs: InstallRow[],
  installsIncludeInternal: boolean,
  installsExpanded: boolean,
  summary: MetricsSummaryRow[],
  daily: MetricsDailyRow[],
  dailyFromHistory: boolean,
  byCountry: MetricsCountryRow[],
  byHour: MetricsHourRow[],
  recentDeploys: MetricsRecentDeployRow[],
): string {
  const statCards = deployStatCards(deployTotals);
  const installListRows = installs
    .map(
      (row) => `<tr>
  <td>${escapeHtml(row.instance || "—")}</td>
  <td>${escapeHtml(row.account || "(unattributed)")}${row.internal ? ` <span class="install-tag">ours</span>` : ""}</td>
  <td>${escapeHtml(row.release)}</td>
  <td>${escapeHtml(row.firstDay)}</td>
  <td>${escapeHtml(row.lastDay)}</td>
  <td class="num">${row.deploys}</td>
</tr>`,
    )
    .join("");
  const installToggle = `<div class="install-toggle" role="group" aria-label="Install list filter">
  <a href="/metrics?installs=public"${installsIncludeInternal ? "" : ` class="active" aria-current="true"`}>Public only</a>
  <a href="/metrics?installs=all"${installsIncludeInternal ? ` class="active" aria-current="true"` : ""}>Include ours</a>
</div>`;
  const dailyRange = dailyFromHistory
    ? `Full history from durable rollups${deployTotals.firstDay ? ` (since ${escapeHtml(deployTotals.firstDay)})` : ""}.`
    : "Last 14 days from Analytics Engine. Longer history appears once the nightly rollup has run.";
  const recentDeployRows = recentDeploys
    .map(
      (row) => `<tr>
  <td>${escapeHtml(formatMetricsTimestamp(row.lastAt))}</td>
  <td>${escapeHtml(row.instance)}</td>
  <td>${escapeHtml(row.account)}</td>
  <td>${escapeHtml(row.release)}</td>
  <td>${escapeHtml(deployStatusLabel(row.status))}</td>
</tr>`,
    )
    .join("");

  const summaryRows = summary
    .map(
      (row) => `<tr>
  <td>${escapeHtml(eventLabel(row.event))}</td>
  <td>${escapeHtml(tagLabel(row.event, row.tag))}</td>
  <td class="num">${row.last24h}</td>
  <td class="num">${row.last7d}</td>
  <td class="num">${row.last30d}</td>
</tr>`,
    )
    .join("");

  const dailyRows = pivotDaily(daily)
    .map(
      (row) => `<tr>
  <td>${escapeHtml(row.day)}</td>
  <td class="num">${row.loginCta}</td>
  <td class="num">${row.loginExpired}</td>
  <td class="num">${row.deployView}</td>
  <td class="num">${row.conversion}</td>
  <td class="num">${row.deploySubmit}</td>
  <td class="num">${row.deploySuccess}</td>
  <td class="num">${row.successRate}</td>
</tr>`,
    )
    .join("");

  const countryRows = byCountry
    .map(
      (row) => `<tr>
  <td>${escapeHtml(row.country)}</td>
  <td class="num">${row.hits}</td>
</tr>`,
    )
    .join("");

  const hourRows = fillHours(byHour)
    .map(
      (row) => `<tr>
  <td>${String(row.hour).padStart(2, "0")}:00 UTC</td>
  <td class="num">${row.hits}</td>
</tr>`,
    )
    .join("");

  return `<p class="eyebrow">Metrics</p>
<h1 class="page-title">GSV deploys &amp; funnel</h1>
<p class="prose">Server-recorded events from Workers Analytics Engine, with long-term history preserved in durable daily rollups. Counts are approximate and can take a few minutes to appear after each event.</p>
<section class="stat-grid" aria-label="GSVs deployed">${statCards}</section>
<p class="hint stat-note">Excludes the humans &amp; machines internal account. <strong>Accounts</strong> = distinct Cloudflare accounts; <strong>installs</strong> = distinct account + install name (someone running two named GSVs in one account counts as two). Both ignore redeploys/updates. <strong>Successful deploys</strong> is the only figure that counts every (re)deploy.</p>
<section class="section">
  <h2>All installs</h2>
  <details class="install-list"${installsExpanded ? " open" : ""}>
    <summary>${installs.length} install${installs.length === 1 ? "" : "s"}${installsIncludeInternal ? " (incl. ours)" : ""} &mdash; account, name, release, dates</summary>
    ${installToggle}
    <table class="metrics-table">
      <thead><tr><th>Install</th><th>Account</th><th>Latest release</th><th>First deployed</th><th>Last deployed</th><th class="num">Deploys</th></tr></thead>
      <tbody>${installListRows || `<tr><td colspan="6">No installs recorded yet.</td></tr>`}</tbody>
    </table>
  </details>
</section>
<section class="section">
  <h2>Recent deploys</h2>
  <table class="metrics-table">
    <thead><tr><th>Time (UTC)</th><th>Instance</th><th>Account</th><th>Release</th><th>Status</th></tr></thead>
    <tbody>${recentDeployRows || `<tr><td colspan="5">No deploys recorded yet.</td></tr>`}</tbody>
  </table>
</section>
<section class="section">
  <h2>Summary</h2>
  <table class="metrics-table">
    <thead><tr><th>Event</th><th>Detail</th><th class="num">24h</th><th class="num">7d</th><th class="num">30d</th></tr></thead>
    <tbody>${summaryRows || `<tr><td colspan="5">No events recorded yet.</td></tr>`}</tbody>
  </table>
</section>
<section class="section">
  <h2>Daily funnel</h2>
  <p class="prose">${dailyRange}</p>
  <table class="metrics-table">
    <thead><tr><th>Day</th><th class="num">Login button clicks</th><th class="num">Login via expired session</th><th class="num">Deploy page views</th><th class="num">Click &rarr; deploy</th><th class="num">Deploy submitted</th><th class="num">Deploy succeeded</th><th class="num">Submit &rarr; success</th></tr></thead>
    <tbody>${dailyRows || `<tr><td colspan="8">No events recorded yet.</td></tr>`}</tbody>
  </table>
</section>
<section class="section">
  <h2>By country, last 90 days</h2>
  <p class="prose">Country-level only, from Cloudflare's edge geolocation. No IP addresses or finer location data are stored.</p>
  <table class="metrics-table">
    <thead><tr><th>Country</th><th class="num">Events</th></tr></thead>
    <tbody>${countryRows || `<tr><td colspan="2">No events recorded yet.</td></tr>`}</tbody>
  </table>
</section>
<section class="section">
  <h2>By hour of day, last 90 days</h2>
  <table class="metrics-table">
    <thead><tr><th>Hour</th><th class="num">Events</th></tr></thead>
    <tbody>${hourRows}</tbody>
  </table>
</section>`;
}

function deployStatCards(totals: DeployTotals): string {
  const cards: Array<{ label: string; value: number; sub: string }> = [
    { label: "Accounts", value: totals.accountsAllTime, sub: "distinct accounts, all time" },
    { label: "GSV installs", value: totals.installsAllTime, sub: "distinct account + name, all time" },
    { label: "New accounts · 30d", value: totals.accounts30d, sub: "distinct accounts" },
    { label: "New installs · 30d", value: totals.installs30d, sub: "distinct installs" },
    { label: "Successful deploys", value: totals.deploysAllTime, sub: "all time, incl. updates" },
  ];
  return cards
    .map(
      (card) => `<div class="stat-card">
  <span class="stat-value">${card.value.toLocaleString("en-US")}</span>
  <span class="stat-label">${escapeHtml(card.label)}</span>
  <span class="stat-sub">${escapeHtml(card.sub)}</span>
</div>`,
    )
    .join("");
}

function formatMetricsTimestamp(value: string): string {
  const date = new Date(value.includes(" ") ? `${value.replace(" ", "T")}Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function deployStatusLabel(status: MetricsRecentDeployRow["status"]): string {
  switch (status) {
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    default:
      return "Running";
  }
}

function fillHours(byHour: MetricsHourRow[]): MetricsHourRow[] {
  const hits = new Map(byHour.map((row) => [row.hour, row.hits]));
  return Array.from({ length: 24 }, (_, hour) => ({ hour, hits: hits.get(hour) ?? 0 }));
}

function eventLabel(event: string): string {
  switch (event) {
    case "login_view":
      return "Login view";
    case "deploy_view":
      return "Deploy page view";
    case "deploy_submit":
      return "Deploy submitted";
    case "deploy_success":
      return "Deploy succeeded";
    default:
      return event;
  }
}

function tagLabel(event: string, tag: string): string {
  if (event === "login_view") {
    return tag === "session_expired" ? "Redirected (expired session)" : "Button click";
  }
  if (event === "deploy_view") {
    return tag === "has_accounts" ? "Authorized with accounts" : "No accounts authorized";
  }
  if (event === "deploy_submit" || event === "deploy_success") {
    return `Release: ${tag}`;
  }
  return tag;
}

function pivotDaily(rows: MetricsDailyRow[]): Array<{
  day: string;
  loginCta: number;
  loginExpired: number;
  deployView: number;
  conversion: string;
  deploySubmit: number;
  deploySuccess: number;
  successRate: string;
}> {
  const days = new Map<
    string,
    { loginCta: number; loginExpired: number; deployView: number; deploySubmit: number; deploySuccess: number }
  >();
  for (const row of rows) {
    const entry = days.get(row.day) ?? { loginCta: 0, loginExpired: 0, deployView: 0, deploySubmit: 0, deploySuccess: 0 };
    if (row.event === "login_view" && row.tag === "cta") entry.loginCta += row.hits;
    else if (row.event === "login_view" && row.tag === "session_expired") entry.loginExpired += row.hits;
    else if (row.event === "deploy_view") entry.deployView += row.hits;
    else if (row.event === "deploy_submit") entry.deploySubmit += row.hits;
    else if (row.event === "deploy_success") entry.deploySuccess += row.hits;
    days.set(row.day, entry);
  }

  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, entry]) => ({
      day,
      loginCta: entry.loginCta,
      loginExpired: entry.loginExpired,
      deployView: entry.deployView,
      conversion: entry.loginCta > 0 ? `${Math.round((entry.deployView / entry.loginCta) * 100)}%` : "—",
      deploySubmit: entry.deploySubmit,
      deploySuccess: entry.deploySuccess,
      successRate: entry.deploySubmit > 0 ? `${Math.round((entry.deploySuccess / entry.deploySubmit) * 100)}%` : "—",
    }));
}

function displayAccount(account: Account): string {
  return account.name?.trim() ? `${account.name} (${account.id})` : account.id;
}

const SCOPE_LABELS: Record<string, string> = {
  "account-settings.read": "Read account settings",
  "billing.read": "Check whether the account uses Workers Free or Paid",
  "user-details.read": "Read your user details",
  "memberships.read": "List your account memberships",
  "workers-scripts.read": "Read Worker scripts",
  "workers-scripts.write": "Deploy and remove Worker scripts",
  "workers-r2.read": "Read R2 storage buckets",
  "workers-r2.write": "Create and delete R2 storage buckets",
  "workers-kv-storage.read": "Read KV namespaces",
  "workers-kv-storage.write": "Create KV namespaces",
  "ai.write": "Use Workers AI",
};

function renderScopeList(scopes: string): string {
  const items = scopes
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return items
    .map((scope) => {
      const label = SCOPE_LABELS[scope];
      const description = label ? `<span class="hint">${escapeHtml(label)}</span>` : "";
      return `<li><code>${escapeHtml(scope)}</code>${description}</li>`;
    })
    .join("");
}

function renderReleaseOptions(releases: ReleaseOption[], selected?: string): string {
  const fallback =
    releases.length > 0
      ? releases
      : [
          { value: "latest", label: "Latest stable", description: "Recommended for most installs." },
          { value: "dev", label: "Dev channel", description: "Newest prerelease build." },
        ];
  return fallback
    .map(
      (release) =>
        `<option value="${escapeHtml(release.value)}"${release.value === selected ? " selected" : ""}>${escapeHtml(release.label)}</option>`,
    )
    .join("");
}

function renderSteps(job: DeployJob): string {
  return job.steps
    .map((step) => {
      const isFailed = step.status === "failed";
      // A failed step always shows a readable reason: its own detail, or the
      // friendly explanation derived from the job error as a fallback.
      const detail = step.detail || (isFailed ? getDeployHelp(job.error ?? "").detail : "");
      const detailBlock = detail
        ? `<p class="step-detail${isFailed ? " step-error" : ""}">${escapeHtml(detail)}</p>`
        : "";
      return `<li class="step-item ${step.status}">
  <span class="step-dot" aria-hidden="true"></span>
  <div class="step-copy">
    <div class="step-title-row">
      <strong>${escapeHtml(step.title)}</strong>
      <span class="step-status">${escapeHtml(stepStatusLabel(step.status))}</span>
    </div>
    <p class="hint">${escapeHtml(step.description)}</p>
    ${detailBlock}
  </div>
</li>`;
    })
    .join("");
}

function progressSummary(job: DeployJob): {
  tone: "pending" | "running" | "success" | "warning" | "failure";
  label: string;
  title: string;
  message: string;
} {
  const warnings = job.steps.filter((step) => step.status === "warning");
  const completed = job.steps.filter((step) => step.status === "complete" || step.status === "warning").length;
  const total = job.steps.length;
  const running = job.steps.find((step) => step.status === "running");
  const failed = job.steps.find((step) => step.status === "failed");

  if (job.status === "failed") {
    return {
      tone: "failure",
      label: "Needs attention",
      title: failed ? failed.title : "Deployment stopped",
      message: failed?.detail || "The deployment did not finish. Open the details below for diagnostics.",
    };
  }

  if (job.status === "succeeded") {
    return warnings.length > 0
      ? {
          tone: "warning",
          label: "Deployed with notes",
          title: "GSV is deployed",
          message: warnings.map((step) => step.detail).filter(Boolean).join(" ") || "GSV is deployed, with one note to review.",
        }
      : {
          tone: "success",
          label: "Complete",
          title: "GSV is ready",
          message: job.result?.gatewayUrl ? "Go to your GSV to create your first user." : "GSV services are deployed.",
        };
  }

  if (running) {
    return {
      tone: "running",
      label: `${completed} of ${total} complete`,
      title: running.title,
      message: running.detail || running.description,
    };
  }

  return {
    tone: "pending",
    label: "Queued",
    title: "Deployment is queued",
    message: "Cloudflare is preparing to start this deployment.",
  };
}

function stepStatusLabel(status: string): string {
  switch (status) {
    case "complete":
      return "Done";
    case "running":
      return "In progress";
    case "warning":
      return "Note";
    case "failed":
      return "Failed";
    default:
      return "Waiting";
  }
}
