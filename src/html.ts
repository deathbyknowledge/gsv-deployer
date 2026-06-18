import type { Context } from "hono";

import type { AppEnv } from "./types";

type PageOptions = {
  title: string;
  description?: string;
  body: string;
  width?: "normal" | "wide";
  refreshSeconds?: number;
  status?: number;
};

export function page(c: Context<AppEnv>, options: PageOptions): Response {
  const refresh = options.refreshSeconds
    ? `<meta http-equiv="refresh" content="${options.refreshSeconds}" />`
    : "";

  void c;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeHtml(options.description ?? "Deploy GSV to Cloudflare with OAuth.")}" />
    ${refresh}
    <title>${escapeHtml(options.title)}</title>
    <style>${styles}</style>
  </head>
  <body>
    <main class="page ${options.width === "wide" ? "wide" : ""}">${options.body}</main>
  </body>
</html>`;
  return new Response(html, {
    status: options.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function cloudflareMark(): string {
  return `<svg class="cloudflare-mark" viewBox="0 0 256 256" aria-hidden="true"><path d="M58 142c0-39 32-71 71-71 33 0 61 23 69 53 19 5 33 22 33 43 0 25-20 45-45 45H83c-32 0-58-26-58-58 0-30 22-54 51-58a70 70 0 0 0-18 46Z" fill="currentColor"/><path d="M80 143c0-27 22-49 49-49 24 0 44 17 48 40l3 14 14 3c8 2 14 9 14 17 0 10-8 18-18 18H84c-18 0-33-15-33-33 0-17 13-31 30-33l19-2-13 15a49 49 0 0 0-7 10Z" fill="#fff"/></svg>`;
}

export function octocatIcon(): string {
  return `<svg class="octocat" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.66 2.33.51.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;
}

const styles = `
:root {
  color-scheme: light;
  --bg: #ffffff;
  --text: #191716;
  --muted: #6f6761;
  --line: #e5e5e5;
  --soft: #f8f6f4;
  --accent: #ff4801;
  --accent-strong: #d83b00;
  --ok: #168a45;
  --warn: #9c6615;
  --bad: #b42318;
  --unknown: #7b7480;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
}

a { color: inherit; }

.page {
  width: min(100%, 46rem);
  margin: 0 auto;
  padding: 4rem 1.25rem 5rem;
}

.page.wide { width: min(100%, 64rem); }

.hero { text-align: center; }

.eyebrow {
  color: var(--accent-strong);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  margin: 0 0 1rem;
  text-transform: uppercase;
}

h1 {
  font-size: clamp(3rem, 9vw, 5.75rem);
  letter-spacing: -0.04em;
  line-height: 0.9;
  margin: 0 auto 1.3rem;
}

.page-title {
  font-size: clamp(2.15rem, 6vw, 3.5rem);
  overflow-wrap: anywhere;
}

.title-row {
  align-items: center;
  display: flex;
  gap: 0.8rem;
}

.cloudflare-mark {
  color: var(--accent);
  flex: 0 0 auto;
  height: 0.8em;
  width: 0.8em;
}

h2 {
  font-size: 1rem;
  letter-spacing: 0.08em;
  margin: 2.5rem 0 0.75rem;
  text-transform: uppercase;
}

p { color: var(--muted); margin: 0 0 1rem; }

.lede {
  color: var(--text);
  font-size: clamp(1.2rem, 3vw, 1.65rem);
  margin: 0 auto 1.5rem;
  max-width: 38rem;
}

.prose {
  color: var(--text);
  font-size: clamp(1.05rem, 2vw, 1.25rem);
  line-height: 1.55;
}

.hero .prose {
  margin-left: auto;
  margin-right: auto;
  max-width: 38rem;
}

.actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  justify-content: center;
  margin: 2rem 0;
}

.actions.left { justify-content: flex-start; }

.button,
.link-button {
  align-items: center;
  border-radius: 999px;
  border: 0;
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-weight: 700;
  gap: 0.45rem;
  justify-content: center;
  min-height: 2.9rem;
  padding: 0 1.15rem;
  text-decoration: none;
}

.button {
  background: var(--accent);
  color: white;
}

.link-button {
  background: white;
  border: 1px solid var(--line);
  color: var(--text);
}

.section {
  border-top: 1px solid var(--line);
  margin-top: 2.5rem;
  padding-top: 1.25rem;
}

.panel {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 1rem;
}

.progress-banner {
  background: var(--soft);
  border: 1px solid var(--line);
  border-left: 4px solid var(--accent);
  border-radius: 8px;
  margin: 1.5rem 0 0;
  padding: 1rem;
}

.progress-banner.success { border-left-color: var(--ok); }
.progress-banner.warning { border-left-color: var(--warn); }
.progress-banner.failure { border-left-color: var(--bad); }
.progress-banner.pending { border-left-color: var(--unknown); }

.progress-banner h2 {
  font-size: 1.35rem;
  letter-spacing: 0;
  line-height: 1.2;
  margin: 0.75rem 0 0.35rem;
  text-transform: none;
}

.progress-banner p { margin-bottom: 0; }

.status-pill {
  background: white;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  display: inline-flex;
  font-size: 0.82rem;
  font-weight: 700;
  min-height: 1.8rem;
  padding: 0.25rem 0.65rem;
}

.form-grid {
  display: grid;
  gap: 1rem;
}

label {
  display: grid;
  font-weight: 700;
  gap: 0.35rem;
}

.hint {
  color: var(--muted);
  font-size: 0.92rem;
  font-weight: 400;
}

input,
select,
textarea {
  background: white;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text);
  font: inherit;
  min-height: 2.8rem;
  padding: 0.65rem 0.75rem;
  width: 100%;
}

.checks {
  display: grid;
  gap: 0.6rem;
}

.check-row {
  align-items: start;
  display: grid;
  gap: 0.6rem;
  grid-template-columns: auto 1fr;
}

.check-row input {
  margin-top: 0.3rem;
  min-height: auto;
  width: auto;
}

.lean-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.lean-list li {
  align-items: baseline;
  border-top: 1px solid var(--line);
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
  padding: 0.8rem 0;
}

.lean-list li:first-child { border-top: 0; }

.marker {
  border-radius: 999px;
  display: inline-block;
  flex: 0 0 auto;
  height: 0.6rem;
  margin-top: 0.45rem;
  width: 0.6rem;
}

.marker.ok { background: var(--ok); }
.marker.warn { background: var(--warn); }
.marker.bad { background: var(--bad); }
.marker.unknown { background: var(--unknown); }

.split {
  align-items: flex-start;
  display: flex;
  gap: 0.75rem;
}

.detail {
  color: var(--muted);
  font-size: 0.92rem;
  margin-left: auto;
  text-align: right;
}

.stepper {
  list-style: none;
  margin: 0;
  padding: 0;
}

.step-item {
  display: grid;
  gap: 0.85rem;
  grid-template-columns: 1.1rem 1fr;
  padding: 0 0 1.2rem;
  position: relative;
}

.step-item:last-child { padding-bottom: 0; }

.step-item:not(:last-child)::before {
  background: var(--line);
  bottom: 0;
  content: "";
  left: 0.42rem;
  position: absolute;
  top: 1.1rem;
  width: 1px;
}

.step-dot {
  background: var(--bg);
  border: 2px solid var(--line);
  border-radius: 999px;
  display: block;
  height: 0.9rem;
  margin-top: 0.25rem;
  position: relative;
  width: 0.9rem;
  z-index: 1;
}

.step-item.complete .step-dot {
  background: var(--ok);
  border-color: var(--ok);
}

.step-item.running .step-dot {
  border-color: var(--accent);
  box-shadow: 0 0 0 4px rgba(255, 72, 1, 0.14);
}

.step-item.warning .step-dot {
  background: var(--warn);
  border-color: var(--warn);
}

.step-item.failed .step-dot {
  background: var(--bad);
  border-color: var(--bad);
}

.step-title-row {
  align-items: baseline;
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
}

.step-title-row strong { overflow-wrap: anywhere; }

.step-status {
  color: var(--muted);
  flex: 0 0 auto;
  font-size: 0.82rem;
  font-weight: 700;
}

.step-detail {
  color: var(--text);
  font-size: 0.95rem;
  margin: 0.35rem 0 0;
}

.diagnostics summary {
  cursor: pointer;
  font-weight: 700;
}

.diagnostics .log { margin-top: 0.85rem; }

.log {
  background: #191716;
  border-radius: 8px;
  color: #f8f6f4;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.86rem;
  line-height: 1.55;
  overflow-x: auto;
  padding: 1rem;
  white-space: pre-wrap;
}

.log .warning { color: #ffd08a; }
.log .error { color: #ffb4a8; }
.success { color: var(--ok); font-weight: 700; }
.failure { color: var(--bad); font-weight: 700; }
.octocat { height: 1.1rem; width: 1.1rem; }

@media (max-width: 560px) {
  .step-title-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.2rem;
  }
}
`;
