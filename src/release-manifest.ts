export const DEPLOYMENT_MANIFEST_FILE =
  "gsv-cloudflare-deployment-manifest.json";

const COMPONENT_GATEWAY = "gateway";
const COMPONENT_RIPGIT = "ripgit";
const LEGACY_COMPONENT_ASSEMBLER = "assembler";
const BUNDLE_PREFIX = "gsv-cloudflare-";
const BUNDLE_SUFFIX = ".tar.gz";
const ADAPTER_ID = /^[a-z][a-z0-9-]*$/;
const GATEWAY_BINDING = /^CHANNEL_[A-Z0-9_]+$/;
const ENV_BINDING = /^[A-Z][A-Z0-9_]*$/;

export type ReleaseAdapterDeployment = {
  gatewayEntrypoint: string;
  adapterEntrypoint: string;
  requiredSecrets: string[];
  selfUrlBinding?: string;
};

export type ReleaseAdapter = {
  id: string;
  displayName: string;
  gatewayBinding: string;
  standalone: ReleaseAdapterDeployment;
};

export type GsvReleaseManifest = {
  version: 1;
  adapters: ReleaseAdapter[];
};

export type ReleaseComponent = {
  id: string;
  bundleFile: string;
  adapter?: ReleaseAdapter;
};

export type ReleaseTopology = {
  manifest: GsvReleaseManifest | null;
  components: ReleaseComponent[];
};

export function parseGsvReleaseManifest(value: unknown): GsvReleaseManifest {
  const root = requireRecord(value, "deployment manifest");
  if (root.version !== 1) {
    throw new Error("Unsupported GSV deployment manifest version.");
  }
  const runtime = requireRecord(root.runtime, "deployment manifest runtime");
  requireString(runtime.gatewayBundle, "runtime.gatewayBundle");
  requireString(runtime.webAssets, "runtime.webAssets");
  requireString(runtime.ripgitBundle, "runtime.ripgitBundle");
  if (!Array.isArray(root.adapters)) {
    throw new Error("Deployment manifest adapters must be an array.");
  }

  const ids = new Set<string>();
  const bindings = new Set<string>();
  const adapters = root.adapters.map((value, index) => {
    const adapter = requireRecord(value, `adapter ${index + 1}`);
    const id = requireMatchingString(adapter.id, ADAPTER_ID, "adapter id");
    const displayName = requireString(adapter.displayName, `adapter ${id} displayName`);
    const gatewayBinding = requireMatchingString(
      adapter.gatewayBinding,
      GATEWAY_BINDING,
      `adapter ${id} gatewayBinding`,
    );
    if (ids.has(id)) throw new Error(`Duplicate adapter id: ${id}.`);
    if (bindings.has(gatewayBinding)) {
      throw new Error(`Duplicate adapter gateway binding: ${gatewayBinding}.`);
    }
    ids.add(id);
    bindings.add(gatewayBinding);
    return {
      id,
      displayName,
      gatewayBinding,
      standalone: parseAdapterDeployment(adapter.standalone, id),
    };
  });

  return { version: 1, adapters };
}

export function topologyFromManifest(
  manifest: GsvReleaseManifest,
): ReleaseTopology {
  return {
    manifest,
    components: [
      releaseComponent(COMPONENT_RIPGIT),
      ...manifest.adapters.map((adapter) => ({
        ...releaseComponent(`channel-${adapter.id}`),
        adapter,
      })),
      releaseComponent(COMPONENT_GATEWAY),
    ],
  };
}

export function legacyTopologyFromChecksums(
  checksums: ReadonlyMap<string, string>,
): ReleaseTopology {
  const channels = [...checksums.keys()]
    .map(componentFromBundleFile)
    .filter((component): component is string => component?.startsWith("channel-") ?? false)
    .sort();
  const components = [COMPONENT_RIPGIT];
  if (checksums.has(bundleFileForComponent(LEGACY_COMPONENT_ASSEMBLER))) {
    components.push(LEGACY_COMPONENT_ASSEMBLER);
  }
  components.push(...channels, COMPONENT_GATEWAY);
  return {
    manifest: null,
    components: components.map(releaseComponent),
  };
}

export function bundleFileForComponent(component: string): string {
  return `${BUNDLE_PREFIX}${component}${BUNDLE_SUFFIX}`;
}

export function componentFromBundleFile(file: string): string | null {
  if (!file.startsWith(BUNDLE_PREFIX) || !file.endsWith(BUNDLE_SUFFIX)) {
    return null;
  }
  const component = file.slice(BUNDLE_PREFIX.length, -BUNDLE_SUFFIX.length);
  return component.length > 0 ? component : null;
}

function releaseComponent(id: string): ReleaseComponent {
  return { id, bundleFile: bundleFileForComponent(id) };
}

function parseAdapterDeployment(value: unknown, id: string): ReleaseAdapterDeployment {
  const deployment = requireRecord(value, `adapter ${id} standalone deployment`);
  requireString(deployment.main, `adapter ${id} main`);
  if (typeof deployment.bundle !== "boolean") {
    throw new Error(`Adapter ${id} bundle must be boolean.`);
  }
  const gatewayEntrypoint = requireString(
    deployment.gatewayEntrypoint,
    `adapter ${id} gatewayEntrypoint`,
  );
  const adapterEntrypoint = requireString(
    deployment.adapterEntrypoint,
    `adapter ${id} adapterEntrypoint`,
  );
  if (!Array.isArray(deployment.durableObjects)) {
    throw new Error(`Adapter ${id} durableObjects must be an array.`);
  }
  for (const [index, value] of deployment.durableObjects.entries()) {
    const durableObject = requireRecord(
      value,
      `adapter ${id} durable object ${index + 1}`,
    );
    requireMatchingString(
      durableObject.binding,
      ENV_BINDING,
      `adapter ${id} durable object binding`,
    );
    requireString(
      durableObject.className,
      `adapter ${id} durable object className`,
    );
  }
  if (!Array.isArray(deployment.requiredSecrets)) {
    throw new Error(`Adapter ${id} requiredSecrets must be an array.`);
  }
  const requiredSecrets = deployment.requiredSecrets.map((secret) =>
    requireMatchingString(secret, ENV_BINDING, `adapter ${id} required secret`)
  );
  const selfUrlBinding = deployment.selfUrlBinding === undefined
    ? undefined
    : requireMatchingString(
      deployment.selfUrlBinding,
      ENV_BINDING,
      `adapter ${id} selfUrlBinding`,
    );
  return {
    gatewayEntrypoint,
    adapterEntrypoint,
    requiredSecrets,
    ...(selfUrlBinding ? { selfUrlBinding } : {}),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireMatchingString(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  const string = requireString(value, label);
  if (!pattern.test(string)) throw new Error(`${label} is invalid.`);
  return string;
}
