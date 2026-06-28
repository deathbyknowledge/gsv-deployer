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
    <footer class="site-footer">Made by <a href="https://humansandmachin.es">Humans &amp; Machines, Inc.</a></footer>
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
  return `<svg class="cloudflare-mark" viewBox="0 0 256 256" aria-hidden="true"><path d="M58 142c0-39 32-71 71-71 33 0 61 23 69 53 19 5 33 22 33 43 0 25-20 45-45 45H83c-32 0-58-26-58-58 0-30 22-54 51-58a70 70 0 0 0-18 46Z" fill="none" stroke="currentColor" stroke-width="14" stroke-linejoin="round"/><path d="M80 143c0-27 22-49 49-49 24 0 44 17 48 40l3 14 14 3c8 2 14 9 14 17 0 10-8 18-18 18H84c-18 0-33-15-33-33 0-17 13-31 30-33l19-2-13 15a49 49 0 0 0-7 10Z" fill="none" stroke="currentColor" stroke-width="8" stroke-linejoin="round"/></svg>`;
}

export function octocatIcon(): string {
  return `<svg class="site-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.66 2.33.51.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;
}

export function discordIcon(): string {
  return `<svg class="site-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.11 18.1.12 18.116a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z"/></svg>`;
}

export function xIcon(): string {
  return `<svg class="site-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.906-5.63Zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;
}

const styles = `
@font-face {
  font-family: "Departure Mono";
  src: url("/assets/departure-mono.woff2") format("woff2");
  font-display: swap;
}

:root {
  color-scheme: light;
  --mono: "Departure Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --serif: Georgia, "Times New Roman", serif;
  --bg: #ffffff;
  --paper: #ffffff;
  --text: #050505;
  --muted: #646875;
  --line: #c9d8ff;
  --line-strong: #1748ff;
  --soft: #f7faff;
  --accent: #1748ff;
  --accent-soft: #e8efff;
  --texture: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'%3E%3Cg fill='%231748ff' fill-opacity='0.24'%3E%3Crect x='1' y='1' width='1' height='1'/%3E%3Crect x='5' y='3' width='1' height='1'/%3E%3Crect x='11' y='2' width='1' height='1'/%3E%3Crect x='15' y='5' width='1' height='1'/%3E%3Crect x='3' y='9' width='1' height='1'/%3E%3Crect x='8' y='8' width='1' height='1'/%3E%3Crect x='13' y='11' width='1' height='1'/%3E%3Crect x='6' y='15' width='1' height='1'/%3E%3Crect x='16' y='16' width='1' height='1'/%3E%3C/g%3E%3C/svg%3E");
  --ok: #2f7458;
  --warn: #927338;
  --bad: #9f3f3f;
  --unknown: #777a78;
}

* { box-sizing: border-box; }

html { background: var(--bg); }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--mono);
  line-height: 1.5;
}

a { color: inherit; }

.page {
  background: var(--paper);
  min-height: 100vh;
  width: min(100%, 72rem);
  margin: 0 auto;
  padding: 2.25rem 3rem 5rem;
}

.page.wide { width: min(100%, 64rem); }

.site-footer {
  color: var(--muted);
  font: 0.76rem var(--mono);
  margin: 0 auto;
  padding: 0 3rem 2rem;
  width: min(100%, 72rem);
}

.site-footer a {
  color: var(--accent);
  text-decoration: none;
}

.site-footer a:hover { text-decoration: underline; }

.home-sheet {
  border-bottom: 1px solid var(--line-strong);
  border-top: 1px solid var(--line-strong);
  position: relative;
}

.home-sheet::after {
  background-image: var(--texture);
  background-size: 1.125rem 1.125rem;
  content: "";
  display: block;
  height: 0.9rem;
  margin: 0 0 1.1rem;
}

.home-masthead {
  align-items: start;
  border-bottom: 1px dotted var(--line-strong);
  color: var(--accent);
  display: grid;
  font-family: var(--mono);
  font-size: 0.75rem;
  gap: 1rem;
  grid-template-columns: 1fr auto;
  padding: 0.75rem 0;
  text-transform: uppercase;
}

.masthead-links {
  align-items: center;
  display: flex;
  gap: 1rem;
}

.masthead-links span { color: var(--accent); }

.home-intro {
  align-items: start;
  display: grid;
  gap: 3rem;
  grid-template-columns: minmax(0, 1fr) minmax(15rem, 20rem);
  padding: 2rem 0 2.25rem;
}

.home-label {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 0.75rem;
  margin-bottom: 1.2rem;
  text-transform: uppercase;
}

.eyebrow {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  margin: 0 0 1rem;
  text-transform: uppercase;
}

h1 {
  color: var(--accent);
  font-size: 3.35rem;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 0.95;
  margin: 0 0 1.2rem;
  max-width: 11ch;
  font-family: var(--mono);
}

.home-copy h1 {
  font-size: 4.25rem;
  line-height: 0.9;
  max-width: 12ch;
  overflow-wrap: anywhere;
  text-transform: uppercase;
}

.page-title {
  font-size: 3rem;
  overflow-wrap: anywhere;
  max-width: none;
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
  color: var(--accent);
  font-family: var(--mono);
  font-size: 0.92rem;
  letter-spacing: 0;
  margin: 2.5rem 0 0.75rem;
  text-transform: uppercase;
}

p { color: var(--muted); margin: 0 0 1rem; }

.lede {
  color: var(--text);
  font-family: var(--serif);
  font-size: 1.08rem;
  line-height: 1.55;
  margin: 0 0 1.15rem;
  max-width: 31rem;
}

.prose {
  color: var(--text);
  font-family: var(--serif);
  font-size: 1rem;
  line-height: 1.6;
  max-width: 32rem;
}

.actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  justify-content: flex-start;
  margin: 1.75rem 0 0;
}

.actions.left { justify-content: flex-start; }

.button,
.link-button {
  align-items: center;
  border-radius: 2px;
  border: 1px solid var(--text);
  cursor: pointer;
  display: inline-flex;
  font: 700 0.88rem var(--mono);
  font-weight: 700;
  gap: 0.45rem;
  justify-content: center;
  min-height: 2.9rem;
  padding: 0 1.15rem;
  text-decoration: none;
  text-transform: uppercase;
}

.button {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--paper);
}

.link-button {
  background: transparent;
  border-color: var(--accent);
  color: var(--accent);
}

.button:hover,
.link-button:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.section {
  border-top: 1px solid var(--line-strong);
  margin-top: 2.5rem;
  padding-top: 1.25rem;
}

.panel {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 2px;
  padding: 1rem;
}

.home-facts {
  border-top: 1px solid var(--line-strong);
  margin: 0;
}

.home-facts div {
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 0.5rem;
  grid-template-columns: 5.5rem minmax(0, 1fr);
  min-height: 3.35rem;
  padding: 0.75rem 0;
}

.home-facts dt {
  color: var(--accent);
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
}

.home-facts dd {
  color: var(--text);
  font-size: 0.88rem;
  margin: 0;
}

.home-manifest {
  padding-top: 1.5rem;
}

.manifest-heading {
  align-items: baseline;
  border-bottom: 1px solid var(--line-strong);
  display: flex;
  font-family: var(--mono);
  justify-content: space-between;
}

.manifest-heading h2 {
  margin: 0 0 0.55rem;
}

.manifest-heading span {
  color: var(--accent);
  font-size: 0.75rem;
  text-transform: uppercase;
}

.manifest-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.manifest-grid div {
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 0.35rem;
  min-height: 5.5rem;
  padding: 0.8rem 1rem 0.85rem 0;
}

.manifest-grid div:nth-child(odd) {
  border-right: 1px solid var(--line);
}

.manifest-grid div:nth-child(even) {
  padding-left: 1rem;
}

.manifest-grid strong {
  color: var(--accent);
  font-family: var(--mono);
  text-transform: uppercase;
}

.manifest-grid span {
  color: var(--muted);
  font-size: 0.92rem;
}

.progress-banner {
  background:
    var(--texture),
    var(--paper);
  background-size: 1.125rem 1.125rem;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 2px;
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
  background: var(--paper);
  border: 1px solid var(--accent);
  border-radius: 2px;
  color: var(--accent);
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
  font-family: var(--mono);
  font-weight: 700;
  gap: 0.35rem;
}

.hint {
  color: var(--muted);
  display: block;
  font-size: 0.92rem;
  font-weight: 400;
}

input,
select,
textarea {
  background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--text);
  font: 0.92rem var(--mono);
  min-height: 2.8rem;
  padding: 0.65rem 0.75rem;
  width: 100%;
}

input[type="checkbox"],
input[type="radio"] {
  accent-color: var(--accent);
  min-height: 1rem;
  padding: 0;
  width: 1rem;
}

input:focus,
select:focus,
textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
  outline: 0;
}

.checks {
  display: grid;
  gap: 0.75rem;
}

.check-row {
  align-items: start;
  display: grid;
  gap: 0.6rem;
  grid-template-columns: auto 1fr;
}

.check-row input {
  margin-top: 0.3rem;
}

.target-options {
  display: grid;
  gap: 0.75rem;
}

.target-card,
.component-card,
.advanced {
  background:
    var(--texture),
    var(--paper);
  background-size: 1.125rem 1.125rem;
  border: 1px solid var(--line);
  border-radius: 2px;
  padding: 1rem;
}

.target-card {
  display: grid;
  gap: 0.85rem;
}

.target-card.compact {
  align-items: start;
  cursor: pointer;
  grid-template-columns: auto 1fr;
}

.radio-row {
  align-items: start;
  cursor: pointer;
  display: grid;
  gap: 0.6rem;
  grid-template-columns: auto 1fr;
}

.radio-row input,
.target-card.compact input {
  margin-top: 0.3rem;
}

.target-field { margin-left: 1.6rem; }

.target-note {
  border: 1px dotted var(--line-strong);
  color: var(--muted);
  padding: 0.85rem 1rem;
}

.component-card {
  display: grid;
  gap: 0.7rem;
}

.component-options,
.advanced {
  color: var(--muted);
}

.component-options summary,
.advanced summary {
  color: var(--accent);
  cursor: pointer;
  font-weight: 700;
}

.component-options label,
.advanced label {
  margin-top: 0.85rem;
}

.component-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.5rem;
}

.component-badges span {
  background: var(--paper);
  border: 1px solid var(--line-strong);
  color: var(--accent);
  font-size: 0.76rem;
  padding: 0.15rem 0.35rem;
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
  border-radius: 2px;
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
  background: var(--line-strong);
  bottom: 0;
  content: "";
  left: 0.42rem;
  position: absolute;
  top: 0;
  width: 1px;
}

.step-dot {
  background: var(--paper);
  border: 2px solid var(--line-strong);
  border-radius: 2px;
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
  box-shadow: 0 0 0 4px var(--accent-soft);
}

.step-item.running .step-dot::after {
  animation: step-pulse 1.4s ease-out infinite;
  border: 1px solid var(--accent);
  content: "";
  inset: -0.45rem;
  position: absolute;
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
  color: var(--accent);
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
  background: #050505;
  border-radius: 2px;
  color: #ffffff;
  font-family: var(--mono);
  font-size: 0.86rem;
  line-height: 1.55;
  overflow-x: auto;
  padding: 1rem;
  white-space: pre-wrap;
}

.log .warning { color: #d9bd77; }
.log .error { color: #ef9b98; }
.success { color: var(--ok); font-weight: 700; }
.failure { color: var(--bad); font-weight: 700; }
.site-icon { height: 1.1rem; width: 1.1rem; }

.home-masthead a,
.masthead-links a {
  color: inherit;
  font-weight: 700;
  text-decoration: none;
}

.home-masthead a:hover,
.masthead-links a:hover { text-decoration: underline; }

@keyframes step-pulse {
  0% { opacity: 0.65; transform: scale(0.75); }
  100% { opacity: 0; transform: scale(1.4); }
}

@media (prefers-reduced-motion: reduce) {
  .step-item.running .step-dot::after { animation: none; }
}

@media (max-width: 760px) {
  .page {
    border-left: 0;
    border-right: 0;
    padding: 1.25rem 1rem 4rem;
  }

  .site-footer {
    padding: 0 1rem 2rem;
  }

  .home-masthead {
    grid-template-columns: 1fr;
  }

  .masthead-links {
    flex-wrap: wrap;
  }

  .home-intro {
    grid-template-columns: 1fr;
    gap: 1.5rem;
    padding: 1.5rem 0;
  }

  h1 { font-size: 2.8rem; }
  .home-copy h1 { font-size: 2.8rem; }
  .page-title { font-size: 2.2rem; }
  .lede { font-size: 1.05rem; }
}

@media (max-width: 560px) {
  .home-copy h1 { font-size: 2.35rem; }

  .manifest-grid {
    grid-template-columns: 1fr;
  }

  .manifest-grid div:nth-child(odd) {
    border-right: 0;
  }

  .manifest-grid div:nth-child(even) {
    padding-left: 0;
  }

  .lean-list li {
    align-items: flex-start;
    flex-direction: column;
  }

  .detail {
    margin-left: 0;
    text-align: left;
  }

  .step-title-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.2rem;
  }
}
`;
