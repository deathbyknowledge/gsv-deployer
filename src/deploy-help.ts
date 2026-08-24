// Maps a raw deployment error message to user-facing help: a friendly summary
// of what went wrong plus concrete next steps. `friendlyErrorDetail` (deploy.ts)
// and the failed-job help block (pages.ts) both read from this single catalog so
// the banner one-liner and the guidance never drift apart.

export type DeployHelpBucket = "self-fixable" | "bug";

export type DeployHelpCategory =
  | "auth-expired"
  | "instance-name"
  | "no-components"
  | "auth-rejected"
  | "permission"
  | "unsupported-release"
  | "release"
  | "checksum"
  | "storage"
  | "workers"
  | "gateway-dependency"
  | "unknown";

export type DeployHelp = {
  category: DeployHelpCategory;
  // Whether this is something the user can fix themselves ("self-fixable") or
  // more likely a platform/our-side problem worth reporting ("bug"). Only the
  // "bug" bucket surfaces the Discord/GitHub report links.
  bucket: DeployHelpBucket;
  // Friendly one-liner describing what went wrong (reused by friendlyErrorDetail).
  detail: string;
  // Actionable next step, phrased for someone who just wants to get deployed.
  whatToDo: string;
};

const HELP_CATALOG: Record<DeployHelpCategory, Omit<DeployHelp, "category">> = {
  "auth-expired": {
    bucket: "self-fixable",
    detail: "Your Cloudflare authorization expired. Start a new deployment and authorize Cloudflare again.",
    whatToDo: "Your Cloudflare login expired. Click Retry to start again, and you'll be asked to reconnect Cloudflare.",
  },
  "instance-name": {
    bucket: "self-fixable",
    detail: "The GSV instance name is not valid. Use lowercase letters, numbers, and dashes only.",
    whatToDo: "Use only lowercase letters, numbers, and dashes for the install name, then Retry.",
  },
  "no-components": {
    bucket: "bug",
    detail: "The deployment did not contain a valid GSV stack.",
    whatToDo: "Retry with Latest stable. If it happens again, report the deployment ID so we can inspect the release.",
  },
  "auth-rejected": {
    bucket: "self-fixable",
    detail: "Cloudflare did not accept this authorization. Log in again and approve the requested account access.",
    whatToDo: "Log in again and approve access to the Cloudflare account you want to deploy to, then Retry.",
  },
  permission: {
    bucket: "self-fixable",
    detail: "Cloudflare rejected a deployment request. Reauthorize with the required scopes or check account permissions.",
    whatToDo:
      "Make sure your Cloudflare account has Workers, R2, and KV enabled on its plan, then Retry. You may need to reauthorize and approve the requested permissions.",
  },
  "unsupported-release": {
    bucket: "self-fixable",
    detail: "This older GSV release is not supported by the current installer because it does not contain the complete stack.",
    whatToDo: "Return to the deploy form, choose Latest stable, and try again.",
  },
  release: {
    bucket: "self-fixable",
    detail: "The selected GSV release is not available. Try the stable channel, the dev channel, or a specific release tag.",
    whatToDo: "Pick a different GSV release (Latest stable is a safe choice) on the deploy form, then Retry.",
  },
  checksum: {
    bucket: "self-fixable",
    detail: "The downloaded release bundle did not match its checksum. Retry the deployment or choose another release.",
    whatToDo: "This is usually a temporary download glitch. Just click Retry.",
  },
  storage: {
    bucket: "bug",
    detail: "Cloudflare could not prepare storage for this GSV. Check that the account has access to the required Workers storage products.",
    whatToDo:
      "Cloudflare couldn't create the storage this GSV needs, usually because R2 isn't enabled, a storage limit was reached, or the name is already in use. Confirm R2 is enabled, then Retry. If it keeps failing, let us know.",
  },
  workers: {
    bucket: "bug",
    detail: "Cloudflare could not deploy or expose one of the Workers. Check Workers permissions and account limits.",
    whatToDo:
      "Cloudflare couldn't upload one of the Workers, often an account limit. Confirm your Workers plan has room, then Retry. If it keeps failing, let us know.",
  },
  "gateway-dependency": {
    bucket: "self-fixable",
    detail: "The selected gateway release is missing a required storage or legacy assembly Worker.",
    whatToDo: "Retry with Latest stable or choose another release. Legacy releases include their package-builder Worker automatically; there is nothing to select manually.",
  },
  unknown: {
    bucket: "bug",
    detail: "Deployment stopped before this step finished. The diagnostics below include the exact service response.",
    whatToDo:
      "This looks like an unexpected problem on our side. Click Retry once. If it happens again, please report it so we can look into it (include the deployment ID below).",
  },
};

// Order matters: earlier matches win when substrings overlap. This mirrors the
// original friendlyErrorDetail branch order so classification stays stable.
export function classifyDeployError(message: string): DeployHelpCategory {
  const lower = message.toLowerCase();
  if (lower.includes("credentials expired") || lower.includes("authorize cloudflare")) return "auth-expired";
  if (lower.includes("instance name")) return "instance-name";
  if (
    lower.includes("no components selected") ||
    lower.includes("no deployable components") ||
    lower.includes("unknown component")
  ) return "no-components";
  if (lower.includes("invalid account") || lower.includes("authentication") || lower.includes("unauthorized")) return "auth-rejected";
  if (lower.includes("forbidden") || lower.includes("permission") || lower.includes("scope")) return "permission";
  if (lower.includes("requires ripgit") || lower.includes("requires the legacy assembler")) return "gateway-dependency";
  if (lower.includes("unsupported gsv release")) return "unsupported-release";
  if (lower.includes("latest stable release") || lower.includes("no dev") || lower.includes("release")) return "release";
  if (lower.includes("checksum")) return "checksum";
  if (lower.includes("r2 bucket") || lower.includes("storage/kv") || lower.includes("kv namespace")) return "storage";
  if (lower.includes("workers/scripts") || lower.includes("upload script") || lower.includes("workers.dev")) return "workers";
  return "unknown";
}

export function getDeployHelp(message: string): DeployHelp {
  const category = classifyDeployError(message);
  return { category, ...HELP_CATALOG[category] };
}
