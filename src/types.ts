export type AppEnv = {
  Bindings: {
    APP_ORIGIN: string;
    CF_OAUTH_CLIENT_ID: string;
    CF_OAUTH_CLIENT_SECRET: string;
    GITHUB_REPO_URL: string;
    GSV_REPO_OWNER?: string;
    GSV_REPO_NAME?: string;
    OAUTH_SCOPES: string;
    OAUTH_TOKEN_AUTH_METHOD: string;
    SESSION_SECRET: string;
    SESSIONS: KVNamespace;
    DEPLOY_WORKFLOW: Workflow<DeployWorkflowParams>;
  };
};

export type Account = {
  id: string;
  name: string;
};

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
};

export type Session = {
  createdAt: string;
  token: TokenResponse;
};

export type DeployStatus = "queued" | "running" | "succeeded" | "failed";
export type DeployStepStatus = "pending" | "running" | "complete" | "warning" | "failed";
export type DeployStepId =
  | "authorize"
  | "release"
  | "prepare"
  | "storage"
  | "workers"
  | "bindings"
  | "adapters"
  | "finish";

export type DeployOptions = {
  accountId: string;
  accountName?: string;
  instance: string;
  version: string;
  components: string[];
  discordBotToken?: string;
  telegramBotToken?: string;
};

export type DeployStep = {
  id: DeployStepId;
  title: string;
  description: string;
  status: DeployStepStatus;
  detail?: string;
  updatedAt?: number;
};

export type DeployJob = {
  id: string;
  sessionId: string;
  status: DeployStatus;
  createdAt: number;
  updatedAt: number;
  options: DeployOptions;
  steps: DeployStep[];
  logs: Array<{ at: number; level: "info" | "warning" | "error"; message: string }>;
  result?: {
    version: string;
    gatewayUrl?: string;
  };
  error?: string;
};

export type DeployWorkflowParams = {
  jobId: string;
};
