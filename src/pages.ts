import type { Account, DeployJob } from "./types";
import { ALL_COMPONENTS } from "./deploy";
import { cloudflareMark, escapeHtml, octocatIcon } from "./html";

export function homePage(repoUrl: string): string {
  return `<section class="hero">
  <p class="eyebrow">Deploy GSV</p>
  <h1>${cloudflareMark()} GSV on Cloudflare</h1>
  <p class="lede">Authorize Cloudflare, choose an account, and deploy a personal GSV without installing the CLI or creating an API token first.</p>
  <p class="prose">This installer uses Cloudflare OAuth, keeps tokens server-side for a short session, deploys prebuilt release bundles to your selected account, and sends you to the new Gateway setup screen.</p>
  <div class="actions">
    <a class="button" href="/login">Log in with Cloudflare</a>
    <a class="link-button" href="${escapeHtml(repoUrl)}">${octocatIcon()} GSV repo</a>
  </div>
</section>
<section class="section">
  <h2>What It Deploys</h2>
  <ul class="lean-list">
    <li><span class="split"><span class="marker ok"></span><span><strong>Gateway</strong><br><span class="hint">Kernel, process runtime, web shell, package host, and Workers AI binding.</span></span></span></li>
    <li><span class="split"><span class="marker ok"></span><span><strong>ripgit and assembler</strong><br><span class="hint">Repository-backed storage and package assembly services.</span></span></span></li>
    <li><span class="split"><span class="marker warn"></span><span><strong>Adapters</strong><br><span class="hint">WhatsApp, Discord, and Telegram Workers are optional and can be configured later.</span></span></span></li>
  </ul>
</section>`;
}

export function deployPage(accounts: Account[], scopes: string): string {
  const accountOptions = accounts
    .map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(displayAccount(account))}</option>`)
    .join("");
  const componentChecks = ALL_COMPONENTS.map(
    (component) => `<label class="check-row"><input type="checkbox" name="component" value="${component}" checked><span><strong>${component}</strong><span class="hint">${componentHint(component)}</span></span></label>`,
  ).join("");

  return `<p class="eyebrow"><a href="/logout">Log out</a></p>
<h1 class="page-title title-row">${cloudflareMark()} Deploy GSV</h1>
<p class="prose">Choose the Cloudflare account and deployment shape. The installer will deploy to workers.dev and redirect you to browser setup when it finishes.</p>
<form class="section form-grid" method="post" action="/deploy">
  <label>
    Cloudflare account
    <select name="accountId" required>${accountOptions}</select>
  </label>
  <label>
    Instance name
    <input name="instance" value="gsv" pattern="[a-z0-9-]+" required>
    <span class="hint">Use a unique prefix such as gsv-personal for a second install in the same account.</span>
  </label>
  <label>
    Release
    <input name="version" value="latest" required>
    <span class="hint">Use latest, stable, dev, or a release tag such as v0.1.0.</span>
  </label>
  <div>
    <h2>Components</h2>
    <div class="checks">${componentChecks}</div>
  </div>
  <label>
    Discord bot token
    <input name="discordBotToken" type="password" autocomplete="off">
    <span class="hint">Optional. You can also configure it later in GSV.</span>
  </label>
  <label>
    Telegram bot token
    <input name="telegramBotToken" type="password" autocomplete="off">
    <span class="hint">Optional. You can also configure it later in GSV.</span>
  </label>
  <div class="panel">
    <strong>Requested Cloudflare OAuth scopes</strong>
    <p class="hint">${escapeHtml(scopes)}</p>
  </div>
  <div class="actions left">
    <button class="button" type="submit">Deploy</button>
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
    <li><strong>Components</strong><span class="detail">${escapeHtml(job.options.components.join(", "))}</span></li>
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

function componentHint(component: string): string {
  switch (component) {
    case "ripgit":
      return " Git-backed storage service.";
    case "assembler":
      return " Package assembly service.";
    case "gateway":
      return " Main GSV worker and web shell.";
    case "channel-whatsapp":
      return " WhatsApp adapter worker.";
    case "channel-discord":
      return " Discord adapter worker.";
    case "channel-telegram":
      return " Telegram adapter worker.";
    default:
      return "";
  }
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
