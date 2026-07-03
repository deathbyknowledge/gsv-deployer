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

## Metrics

The Worker writes two funnel events to a Workers Analytics Engine dataset
(`gsv_deploy_metrics`, binding `METRICS`, created automatically on first
write — no setup needed):

- `login_view`: recorded on every `GET /login` hit, tagged `cta` (link click
  from the home page) or `session_expired` (redirected here after an
  expired/missing session on `/deploy` or `/jobs/:id`).
- `deploy_view`: recorded on every `GET /deploy` that passes session auth,
  tagged `has_accounts` or `no_accounts` depending on whether Cloudflare
  returned an authorized account for the session.

### Dashboard

`GET /metrics` renders a small built-in dashboard (summary counts for 24h/7d/30d
plus a 14-day daily breakdown with click-to-deploy conversion) so the team can
check it in a browser instead of running SQL by hand. It's gated with HTTP
Basic Auth, not the Cloudflare OAuth session, since anyone can self-authorize
through `/login` to deploy their own GSV.

Setup:

1. Set the real account ID in `wrangler.jsonc` under `vars.CF_ACCOUNT_ID`
   (replacing `replace-with-cloudflare-account-id`).
2. Create a Cloudflare API token scoped to **Account Analytics: Read** for
   that account (dash.cloudflare.com → My Profile → API Tokens), and set it:

   ```bash
   npx wrangler secret put CF_ANALYTICS_API_TOKEN
   ```

3. Pick a shared username/password for the team and set them:

   ```bash
   npx wrangler secret put METRICS_USER
   npx wrangler secret put METRICS_PASSWORD
   ```

Then visit `https://deploy.gsv.space/metrics` and sign in with those
credentials when prompted.

### Querying directly

You can also query the Analytics Engine SQL API directly (replace
`$CF_ACCOUNT_ID` and `$CF_API_TOKEN`):

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  --data "SELECT blob1 AS event, blob2 AS tag, count() AS hits
          FROM gsv_deploy_metrics
          WHERE timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY blob1, blob2
          ORDER BY blob1, hits DESC"
```

Analytics Engine data is sampled/aggregated and not queryable until a few
minutes after ingestion.
