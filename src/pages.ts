import type { Account, DeployJob } from "./types";
import { ALL_COMPONENTS, storageBucketNameForInstance } from "./deploy";
import type { ExistingGsvInstallation, ReleaseOption } from "./deploy";
import { getDeployHelp } from "./deploy-help";
import { cloudflareMark, discordIcon, escapeHtml, octocatIcon, xIcon } from "./html";

const HELP_DISCORD_URL = "https://discord.gg/hy9ExJJFvn";
import type { MetricsCountryRow, MetricsDailyRow, MetricsHourRow, MetricsRecentDeployRow, MetricsSummaryRow } from "./metrics";

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
      <p class="home-label">Cloud computer</p>
      <h1>GSV</h1>
      <p class="lede">a mind for your machines</p>
      <p class="prose">GSV is a personal AI computer that spans all your devices at once and stays awake even when they're asleep. One mind across all your machines, not stuck on any single one. Open source, running on the edge in your own Cloudflare account: your keys, your data. From ~$5/mo infra plus your own model costs. No box to babysit.</p>
      <p class="prose"><a href="https://docs.gsv.space/get-started/"><em>Get started guide</em></a></p>
      <p class="prose"><u>Cloudflare account on a Workers Paid plan (~$5/mo) and R2 object storage enabled required.</u></p>
      <div class="actions">
        <a class="button" href="/login">Log in with Cloudflare</a>
      </div>
    </article>
    <div class="home-side">
      <p class="manifest-intro">Everything below deploys to your own Cloudflare account. Nothing runs on ours.</p>
      <dl class="home-facts" aria-label="What deploys">
        <div><dt>Core GSV</dt><dd>Desktop, users, agents, and settings. Runs as Workers + Durable Objects.</dd></div>
        <div><dt>Storage</dt><dd>Your files, Wiki, packages, and process state, in your own R2 bucket.</dd></div>
        <div><dt>Package builder</dt><dd>Builds and installs GSV apps you or others write.</dd></div>
        <div><dt>Channels</dt><dd>Optional. Connect WhatsApp, Discord, or Telegram to chat with GSV from anywhere.</dd></div>
      </dl>
    </div>
  </div>
</section>
<section class="home-manifest">
  <div class="manifest-grid">
    <div><strong>Devices</strong><span>Connect every machine you own: laptops, servers, workstations. GSV works across all of them at once, where your files and tools already live.</span></div>
    <div><strong>Agents</strong><span>Personal, custom, and background agents that work on your behalf, even when your devices are asleep.</span></div>
    <div><strong>Desktop</strong><span>Chat, Files, Shell, and Wiki in one console. One place to drive the whole system.</span></div>
    <div><strong>Knowledge</strong><span>Files and Wiki keep what matters after a conversation ends. Your system remembers.</span></div>
  </div>
</section>`;
}

export type DeployPrefill = {
  mode?: "retry" | "update";
  accountId?: string;
  instance?: string;
  version?: string;
  components?: string[];
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
  const selectedComponents = prefill?.components ? new Set(prefill.components) : null;
  const componentChecks = ALL_COMPONENTS.map((component) =>
    componentControl(component, selectedComponents ? selectedComponents.has(component) : true),
  ).join("");
  const isUpdate = Boolean(prefill?.mode === "update" && prefill.accountId && prefill.instance);

  // The "new install name" field only applies to a new target; it is hidden when
  // updating an existing install (its name is fixed by the chosen target).
  const instanceValue = (!isUpdate && prefill?.instance) || "gsv";
  const advancedOpen = !isUpdate && instanceValue !== "gsv" ? " open" : "";
  const note = isUpdate
    ? `<p class="prose retry-note">Choose a release and the components you want, then apply the update. Any Discord or Telegram bot tokens need to be re-entered.</p>`
    : prefill
      ? `<p class="prose retry-note">Retrying your last deployment. Review the settings below and deploy again. Any Discord or Telegram bot tokens need to be re-entered.</p>`
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
    ? "Adjust the release and components for this GSV, then apply the update."
    : "Choose where this GSV should live and which release to install.";
  // Advanced options only apply to a new deploy: the install name and the
  // read-only summary of the Cloudflare access you granted at login. Updating an
  // existing install changes neither, so the whole section is dropped there.
  const advancedSection = isUpdate
    ? ""
    : `<details class="advanced"${advancedOpen}>
    <summary>Advanced</summary>
    <label>
      Install name
      <input name="instance" value="${escapeHtml(instanceValue)}" pattern="[a-z0-9-]+" required>
      <span class="hint">Pick a unique name such as gsv-personal when running multiple GSVs in one account.</span>
    </label>
    <div class="panel scope-panel">
      <strong>What this installer can access</strong>
      <p class="hint">Cloudflare OAuth permissions you granted at login.</p>
      <ul class="scope-list">${renderScopeList(scopes)}</ul>
    </div>
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
  <label>
    Release
    <select name="version" required>${renderReleaseOptions(releases, prefill?.version)}</select>
    <span class="hint">Exact release tags are loaded from GitHub. Use latest stable unless you need a specific build.</span>
  </label>
  <div>
    <h2>Components</h2>
    <div class="checks">${componentChecks}</div>
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
    components: install.components.join(","),
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
  if (installations.length === 0) {
    return `<p class="eyebrow"><a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} Your GSVs</h1>
<p class="prose">No GSV installs were detected in your Cloudflare accounts yet. Deploy your first one to get started.</p>
<div class="actions left">
  <a class="button" href="/deploy">Deploy your first GSV</a>
</div>`;
  }

  const cards = installations
    .map(
      (install) => `<li class="manage-card">
  <div class="manage-card-head">
    <strong>${escapeHtml(install.instance)}</strong>
    <span class="hint">${escapeHtml(install.accountName)}</span>
  </div>
  <span class="component-badges">${install.components.map((component) => `<span>${escapeHtml(componentName(component))}</span>`).join("")}</span>
  <div class="actions left">
    <a class="link-button" href="${escapeHtml(manageUpdateHref(install))}">Update</a>
    <a class="link-button danger" href="${escapeHtml(manageDeleteHref(install))}">Delete</a>
  </div>
</li>`,
    )
    .join("");

  const count = installations.length === 1 ? "One GSV install" : `${installations.length} GSV installs`;
  return `<p class="eyebrow"><a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} Your GSVs</h1>
<p class="prose">${count} detected in your Cloudflare accounts. Pick one to update or delete, or deploy a new install.</p>
<section class="section">
  <ul class="manage-list">${cards}</ul>
</section>
<div class="actions left">
  <a class="button" href="/deploy">Deploy a new GSV</a>
</div>`;
}

export function confirmDeletePage(install: ExistingGsvInstallation): string {
  const scripts = install.scriptNames.length > 0 ? install.scriptNames : install.components.map((c) => componentName(c));
  const bucketName = storageBucketNameForInstance(install.instance);
  return `<p class="eyebrow"><a href="/manage">Your GSVs</a> / <a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} Delete ${escapeHtml(install.instance)}</h1>
<p class="prose">This removes the Worker scripts for <strong>${escapeHtml(install.instance)}</strong> in <strong>${escapeHtml(install.accountName)}</strong>. By default your R2 storage bucket and its data are left untouched, so you can redeploy later without losing files.</p>
<section class="section danger-zone">
  <h2>Workers to remove</h2>
  <ul class="lean-list script-list">${scripts.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join("")}</ul>
  <form method="post" action="/manage/delete">
    <input type="hidden" name="accountId" value="${escapeHtml(install.accountId)}">
    <input type="hidden" name="instance" value="${escapeHtml(install.instance)}">
    <label class="check-row danger-check">
      <input type="checkbox" name="deleteStorage" value="1">
      <span>
        <strong>Also delete storage</strong>
        <span class="hint">Permanently deletes the R2 bucket <code>${escapeHtml(bucketName)}</code> and all files in it. This can't be undone. The bucket must be empty of objects for Cloudflare to remove it.</span>
      </span>
    </label>
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
    <li><strong>Components</strong><span class="detail">${escapeHtml(formatComponents(job.options.components))}</span></li>
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
    components: job.options.components.join(","),
  });
  return `/deploy?${params.toString()}`;
}

function failureHelp(job: DeployJob): string {
  const help = getDeployHelp(job.error ?? "");
  const hasChannels = job.options.components.some((component) => component.startsWith("channel-"));
  const tokenNote = hasChannels
    ? `<p class="hint token-note">You'll re-enter any Discord or Telegram bot tokens on the retry, since they aren't stored.</p>`
    : "";
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
  ${tokenNote}
  ${report}
</section>`;
}

export function errorPage(title: string, message: string): string {
  return `<p class="eyebrow"><a href="/">Home</a></p>
<h1 class="page-title">${escapeHtml(title)}</h1>
<p class="prose">${escapeHtml(message)}</p>`;
}

export function metricsPage(
  summary: MetricsSummaryRow[],
  daily: MetricsDailyRow[],
  byCountry: MetricsCountryRow[],
  byHour: MetricsHourRow[],
  recentDeploys: MetricsRecentDeployRow[],
): string {
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
<h1 class="page-title">Login &amp; deploy funnel</h1>
<p class="prose">Server-recorded events from Workers Analytics Engine. Counts are approximate and can take a few minutes to appear after each event.</p>
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
  <h2>Daily, last 14 days</h2>
  <table class="metrics-table">
    <thead><tr><th>Day</th><th class="num">Login button clicks</th><th class="num">Login via expired session</th><th class="num">Deploy page views</th><th class="num">Click &rarr; deploy</th><th class="num">Deploy submitted</th><th class="num">Deploy succeeded</th><th class="num">Submit &rarr; success</th></tr></thead>
    <tbody>${dailyRows || `<tr><td colspan="8">No events recorded yet.</td></tr>`}</tbody>
  </table>
</section>
<section class="section">
  <h2>By country, last 30 days</h2>
  <p class="prose">Country-level only, from Cloudflare's edge geolocation. No IP addresses or finer location data are stored.</p>
  <table class="metrics-table">
    <thead><tr><th>Country</th><th class="num">Events</th></tr></thead>
    <tbody>${countryRows || `<tr><td colspan="2">No events recorded yet.</td></tr>`}</tbody>
  </table>
</section>
<section class="section">
  <h2>By hour of day, last 30 days</h2>
  <table class="metrics-table">
    <thead><tr><th>Hour</th><th class="num">Events</th></tr></thead>
    <tbody>${hourRows}</tbody>
  </table>
</section>`;
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

function componentControl(component: string, checked: boolean): string {
  const token = channelTokenField(component);
  return `<div class="component-card">
  <label class="check-row"><input type="checkbox" name="component" value="${component}"${checked ? " checked" : ""}><span><strong>${escapeHtml(componentName(component))}</strong><span class="hint">${escapeHtml(componentHint(component))}</span></span></label>
  ${token}
</div>`;
}

function channelTokenField(component: string): string {
  if (component === "channel-discord") {
    return `<details class="component-options">
  <summary>Discord bot token</summary>
  <label>
    Bot token
    <input name="discordBotToken" type="password" autocomplete="off">
    <span class="hint">Optional. You can also configure Discord later in GSV.</span>
  </label>
</details>`;
  }
  if (component === "channel-telegram") {
    return `<details class="component-options">
  <summary>Telegram bot token</summary>
  <label>
    Bot token
    <input name="telegramBotToken" type="password" autocomplete="off">
    <span class="hint">Optional. You can also configure Telegram later in GSV.</span>
  </label>
</details>`;
  }
  return "";
}

function componentName(component: string): string {
  switch (component) {
    case "ripgit":
      return "Storage";
    case "assembler":
      return "Package builder";
    case "gateway":
      return "Core GSV";
    case "channel-whatsapp":
      return "WhatsApp channel";
    case "channel-discord":
      return "Discord channel";
    case "channel-telegram":
      return "Telegram channel";
    default:
      return component;
  }
}

function componentHint(component: string): string {
  switch (component) {
    case "ripgit":
      return "Home files, Wiki, package source, artifacts, and process state.";
    case "assembler":
      return "Builds and installs GSV package apps.";
    case "gateway":
      return "Desktop, users, agents, files, settings, and setup.";
    case "channel-whatsapp":
      return "Optional WhatsApp message adapter.";
    case "channel-discord":
      return "Optional Discord message adapter.";
    case "channel-telegram":
      return "Optional Telegram message adapter.";
    default:
      return "";
  }
}

function formatComponents(components: string[]): string {
  return components.map(componentName).join(", ");
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
          message: job.result?.gatewayUrl ? "Go to your GSV to create your first user." : "The selected components are deployed.",
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
