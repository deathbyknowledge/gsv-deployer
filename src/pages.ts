import type { Account, DeployJob } from "./types";
import { ALL_COMPONENTS } from "./deploy";
import type { ExistingGsvInstallation, ReleaseOption } from "./deploy";
import { cloudflareMark, escapeHtml, octocatIcon } from "./html";

export function homePage(repoUrl: string): string {
  return `<section class="home-sheet">
  <header class="home-masthead">
    <strong>GSV</strong>
    <span>General Systems Vehicle</span>
  </header>
  <div class="home-intro">
    <article class="home-copy">
      <p class="home-label">Cloud computer</p>
      <h1>GSV</h1>
      <p class="lede">A computer for humans and machines.</p>
      <p class="prose">GSV is your cloud computer. It gives you a desktop, files, apps, agents, settings, connected devices, and integrations that can keep working even when one browser tab is closed.</p>
      <div class="actions">
        <a class="button" href="/login">Log in with Cloudflare</a>
        <a class="link-button" href="${escapeHtml(repoUrl)}">${octocatIcon()} GSV repo</a>
      </div>
    </article>
    <dl class="home-facts" aria-label="GSV overview">
      <div><dt>Desktop</dt><dd>Chat, Files, Shell, Wiki, and the GSV console.</dd></div>
      <div><dt>Agents</dt><dd>Personal, custom, package, and background agents that can work on your behalf.</dd></div>
      <div><dt>Devices</dt><dd>Connect laptops, servers, and workstations so GSV can work where your files and tools live.</dd></div>
      <div><dt>Knowledge</dt><dd>Files and Wiki keep durable material after a conversation ends.</dd></div>
    </dl>
  </div>
</section>
<section class="home-manifest">
  <div class="manifest-heading">
    <h2>Component manifest</h2>
    <span>Default install</span>
  </div>
  <div class="manifest-grid">
    <div><strong>Core GSV</strong><span>Desktop, users, agents, files, settings, and first-run setup.</span></div>
    <div><strong>Storage</strong><span>Home files, Wiki, package source, artifacts, and process state.</span></div>
    <div><strong>Package builder</strong><span>Builds and installs GSV package apps.</span></div>
    <div><strong>Channels</strong><span>Optional message adapters for WhatsApp, Discord, and Telegram.</span></div>
  </div>
</section>`;
}

export function deployPage(
  accounts: Account[],
  scopes: string,
  releases: ReleaseOption[],
  installations: ExistingGsvInstallation[],
): string {
  const accountOptions = accounts
    .map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(displayAccount(account))}</option>`)
    .join("");
  const componentChecks = ALL_COMPONENTS.map(componentControl).join("");
  const existingTargets = renderExistingTargets(installations);

  return `<p class="eyebrow"><a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} Deploy GSV</h1>
<p class="prose">Choose where this GSV should live and which release to install. Existing GSVs can be updated here too.</p>
<form class="section form-grid" method="post" action="/deploy">
  <div>
    <h2>Target</h2>
    <div class="target-options">
      <div class="target-card">
        <label class="radio-row"><input type="radio" name="target" value="new" checked><span><strong>New GSV install</strong><span class="hint">Use the default name unless you need a second install in the same Cloudflare account.</span></span></label>
        <label class="target-field">
          Cloudflare account
          <select name="accountId" required>${accountOptions}</select>
        </label>
      </div>
      ${existingTargets}
    </div>
  </div>
  <label>
    Release
    <select name="version" required>${renderReleaseOptions(releases)}</select>
    <span class="hint">Exact release tags are loaded from GitHub. Use latest stable unless you need a specific build.</span>
  </label>
  <div>
    <h2>Components</h2>
    <div class="checks">${componentChecks}</div>
  </div>
  <details class="advanced">
    <summary>Advanced</summary>
    <label>
      New install name
      <input name="instance" value="gsv" pattern="[a-z0-9-]+" required>
      <span class="hint">Only used for new installs. Pick a unique name such as gsv-personal when running multiple GSVs in one account.</span>
    </label>
    <div class="panel">
      <strong>Requested Cloudflare OAuth scopes</strong>
      <p class="hint">${escapeHtml(scopes)}</p>
    </div>
  </details>
  <div class="actions left">
    <button class="button" type="submit">Deploy or update</button>
    <a class="link-button" href="/logout">Cancel</a>
  </div>
</form>`;
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
    ? `<div class="actions left"><a class="button" href="${escapeHtml(job.result.gatewayUrl)}">Open GSV setup</a><a class="link-button" href="/deploy">Deploy another</a></div>`
    : "";

  return `<p class="eyebrow"><a href="/deploy">Deploy</a> / <a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} ${escapeHtml(job.options.instance)}</h1>
<section class="progress-banner ${progress.tone}">
  <span class="status-pill">${escapeHtml(progress.label)}</span>
  <h2>${escapeHtml(progress.title)}</h2>
  <p>${escapeHtml(progress.message)}</p>
</section>
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
</section>`;
}

export function errorPage(title: string, message: string): string {
  return `<p class="eyebrow"><a href="/">Home</a></p>
<h1 class="page-title">${escapeHtml(title)}</h1>
<p class="prose">${escapeHtml(message)}</p>`;
}

function displayAccount(account: Account): string {
  return account.name?.trim() ? `${account.name} (${account.id})` : account.id;
}

function renderExistingTargets(installations: ExistingGsvInstallation[]): string {
  if (installations.length === 0) {
    return `<div class="target-note">No existing GSV installs were detected in the authorized accounts.</div>`;
  }

  return installations
    .map(
      (installation) => `<label class="target-card compact">
  <input type="radio" name="target" value="existing|${escapeHtml(installation.accountId)}|${escapeHtml(installation.instance)}">
  <span>
    <strong>Update ${escapeHtml(installation.instance)}</strong>
    <span class="hint">${escapeHtml(installation.accountName)}</span>
    <span class="component-badges">${installation.components.map((component) => `<span>${escapeHtml(componentName(component))}</span>`).join("")}</span>
  </span>
</label>`,
    )
    .join("");
}

function renderReleaseOptions(releases: ReleaseOption[]): string {
  const fallback =
    releases.length > 0
      ? releases
      : [
          { value: "latest", label: "Latest stable", description: "Recommended for most installs." },
          { value: "dev", label: "Dev channel", description: "Newest prerelease build." },
        ];
  return fallback
    .map((release) => `<option value="${escapeHtml(release.value)}">${escapeHtml(release.label)}</option>`)
    .join("");
}

function componentControl(component: string): string {
  const token = channelTokenField(component);
  return `<div class="component-card">
  <label class="check-row"><input type="checkbox" name="component" value="${component}" checked><span><strong>${escapeHtml(componentName(component))}</strong><span class="hint">${escapeHtml(componentHint(component))}</span></span></label>
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
    .map(
      (step) => `<li class="step-item ${step.status}">
  <span class="step-dot" aria-hidden="true"></span>
  <div class="step-copy">
    <div class="step-title-row">
      <strong>${escapeHtml(step.title)}</strong>
      <span class="step-status">${escapeHtml(stepStatusLabel(step.status))}</span>
    </div>
    <p class="hint">${escapeHtml(step.description)}</p>
    ${step.detail ? `<p class="step-detail">${escapeHtml(step.detail)}</p>` : ""}
  </div>
</li>`,
    )
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
          message: job.result?.gatewayUrl ? "Open the setup screen to create your first GSV user." : "The selected components are deployed.",
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
