# GSV Deployment

Browser-first installer for GSV on Cloudflare.

This Worker lets a user authorize a Cloudflare account with OAuth, choose a GSV
release and instance name, then deploy the prebuilt GSV Cloudflare bundles into
that account without creating an API token or installing the `gsv` CLI first.

## Setup

Create a KV namespace for installer sessions and jobs:

```bash
npx wrangler kv namespace create SESSIONS
```

Copy the namespace ID into `wrangler.jsonc`, replacing
`replace-with-kv-namespace-id`.

Create a Cloudflare OAuth client:

- Response type: `code`
- Grant type: `authorization_code`
- Token authentication method: `client_secret_post`
- Client URL: `https://gsv-deployment.the-agents-company.workers.dev`
- Privacy policy URL: `https://gsv-deployment.the-agents-company.workers.dev/privacy`
- Terms URL: `https://gsv-deployment.the-agents-company.workers.dev/terms`
- Redirect URL:

```text
https://gsv-deployment.the-agents-company.workers.dev/oauth/callback
```

Use the scopes in `wrangler.jsonc` as the starting point for the client. The
OAuth scope catalog is account-authenticated, so verify the final IDs before
publishing the client:

```bash
curl https://api.cloudflare.com/client/v4/oauth/scopes \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

Set the deployed installer URL in `APP_ORIGIN`, then set secrets:

```bash
npx wrangler secret put CF_OAUTH_CLIENT_ID
npx wrangler secret put CF_OAUTH_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

Optionally set `GITHUB_TOKEN` to a read-only GitHub token that can access the
configured GSV repository releases. The installer uses it only to load exact
release tags for the deploy form; deploying `latest`, `stable`, `dev`, or an
explicit tag does not require GitHub REST API access.

The first deploy may use placeholder OAuth secrets only to discover the
workers.dev URL. Replace them with the real `CF_OAUTH_CLIENT_ID` and
`CF_OAUTH_CLIENT_SECRET` from the OAuth client before using `/login`.

Deploy the installer:

```bash
npm run deploy
```

For local development, set equivalent values in `.dev.vars`.

## Development

```bash
npm install
npm run typecheck
npm run dev
```

## Notes

The installer keeps Cloudflare OAuth tokens server-side in KV for short-lived
sessions. It does not persist refresh tokens for long-term account management.
Future upgrades or teardown should ask the user to authorize again.

Deployments run in a Cloudflare Workflow. The browser creates a deploy job,
starts a Workflow instance, and then polls the job page while the Worker-side
workflow performs the Cloudflare API calls.
