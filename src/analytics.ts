// Client-side analytics tracker, served as a same-origin script so the page's
// Content-Security-Policy stays at `script-src 'self'` (no inline scripts).
//
// It fires two Cloudflare Zaraz custom events, keyed off the job page:
//   - deploy_submit  — a deploy job was created (arrived via the ?submitted=1 redirect)
//   - deploy_success — a job reached the "succeeded" state
//
// Both are guarded to fire exactly once per job id, so the job page's 4-second
// meta-refresh (and manual reloads / revisits) never double-count. Event
// properties carry only the release channel — no personal data.
//
// zaraz.track() may be called before the Zaraz script has finished loading. We
// never assume window.zaraz exists: calls are wrapped so they cannot throw, and
// a short bounded retry catches the case where Zaraz loads slightly after us.
export const ANALYTICS_SCRIPT = `(function () {
  var el = document.getElementById("gsv-analytics");
  if (!el) return;
  var jobId = el.getAttribute("data-job-id") || "";
  var release = el.getAttribute("data-release") || "";
  var status = el.getAttribute("data-status") || "";
  if (!jobId) return;

  function track(event, props) {
    try {
      if (window.zaraz && typeof window.zaraz.track === "function") {
        window.zaraz.track(event, props);
        return true;
      }
    } catch (_) { /* analytics must never break the app */ }
    return false;
  }

  function fired(storage, key) {
    try { return storage.getItem(key) === "1"; } catch (_) { return false; }
  }
  function markFired(storage, key) {
    try { storage.setItem(key, "1"); } catch (_) {}
  }

  function stripSubmittedParam() {
    try {
      var params = new URLSearchParams(window.location.search);
      if (!params.has("submitted")) return;
      params.delete("submitted");
      var q = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (q ? "?" + q : ""));
    } catch (_) {}
  }

  function cameFromSubmit() {
    try { return new URLSearchParams(window.location.search).get("submitted") === "1"; }
    catch (_) { return false; }
  }

  var submitKey = "gsv_deploy_submit_" + jobId;
  var successKey = "gsv_deploy_success_" + jobId;

  // deploy_submit: only on the create redirect, once per job (session-scoped).
  // deploy_success: only on the succeeded state, once per job (persisted).
  var wantSubmit = cameFromSubmit() && !fired(sessionStorage, submitKey);
  var wantSuccess = status === "succeeded" && !fired(localStorage, successKey);

  if (!wantSubmit && !wantSuccess) {
    stripSubmittedParam();
    return;
  }

  var attempts = 0;
  (function attempt() {
    var ready = !!(window.zaraz && typeof window.zaraz.track === "function");
    if (ready) {
      if (wantSubmit && track("deploy_submit", { release: release })) {
        markFired(sessionStorage, submitKey);
      }
      if (wantSuccess && track("deploy_success", { release: release })) {
        markFired(localStorage, successKey);
      }
      stripSubmittedParam();
      return;
    }
    // Zaraz not ready yet — retry briefly (~10s) so early calls aren't lost.
    // On a queued/running job the 4s meta-refresh also gives fresh attempts.
    if (++attempts > 40) {
      stripSubmittedParam();
      return;
    }
    setTimeout(attempt, 250);
  })();
})();
`;
