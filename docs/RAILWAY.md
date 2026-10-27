# Railway

Nothing here was deployed. The Dockerfile build and the start steps were checked by running the same commands
by hand (`npm ci`, `npm run build`, `npm ci --omit=dev`, `node dist/main.js`, SIGTERM); the image itself was not
built (no Docker on the build machine).

## Build and start: a `Dockerfile`, no `railway.json`

Railway always builds from a `Dockerfile` it finds in the repo, so there is nothing else to configure for build
and start: two stages on `node:22-slim`, build with `tsc`, run `node dist/main.js` as the unprivileged `node` user.

Why not `railway.json`: Railway's own docs now mark config-as-code as deprecated ("existing files keep working
for legacy services until 2026-12-01"), and Railpack would guess the Node version and start command. A
Dockerfile pins Node 22, is auto-detected, does not depend on a deprecated file, and runs identically on a laptop.
The few settings that would have lived in `railway.json` (health check, draining) are service settings or
variables below.

## Service

1. New project, "Deploy from GitHub repo", `kristian-aviary/aviary_assistant_bot`, branch `main`.
2. Add the PostgreSQL plugin to the project. Migrations run at start from the service; nothing to run by hand.
3. One replica is enough. If two run (during a deploy, Railway overlaps old and new), correctness holds: sends are
   guarded by the Postgres idempotency claim and migrations by an advisory lock.

### Variables (names only; no values here)

| Variable | Source |
|---|---|
| `DATABASE_URL` | reference the plugin: `${{Postgres.DATABASE_URL}}` (the private-network URL, not the public proxy) |
| `GERTRUDE_URL` | Gertrude's API base URL |
| `GERTRUDE_VERIFY_TOKEN` | same value as Gertrude's `TEAMS_BOT_VERIFY_TOKEN` |
| `SEND_SERVICE_TOKEN` | same value as Gertrude's `TEAMS_BOT_SERVICE_TOKEN`; must differ from the one above (startup refuses equal values) |
| `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` | the bot registration (see [TEAMS-SETUP.md](TEAMS-SETUP.md)) |
| `PORT` | set by Railway; do not set it yourself |
| `SERVICE_URL_ALLOWED_HOSTS` | optional |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | set to `15` (see SIGTERM) |

Startup fails with `Invalid configuration: missing <NAME>` (exit 1, no values printed) if one is absent, and the
deploy is marked failed.

### Health check

Settings, Deploy, Healthcheck Path: `/healthz`. It answers `200 {"ok":true}` only when Postgres answers (2 s
cap) and `503 {"ok":false}` otherwise; no auth, no secrets. A timeout of 60 s is plenty (migrations run before
the server listens).

### Start command

Leave it empty: the Dockerfile's `CMD ["node", "dist/main.js"]` is used. To run migrations on their own
(optional), the same image has `node dist/migrate.js`.

## SIGTERM

Railway sends `SIGTERM` to the old deployment when a new one is live, then `SIGKILL` after the draining time.
The service handles `SIGTERM` (and `SIGINT`):

1. `/v1/send` immediately answers `503 unavailable` for anything new, and claims no keys, so Gertrude retries.
2. The listener closes; idle connections are dropped, busy ones finish.
3. In-flight sends are awaited for up to 10 s (the Teams call itself is capped at 8 s).
4. A short flush, remaining sockets are cut, the Postgres pool is closed, exit 0.

A send still running at the deadline is left `in_progress` in Postgres, which replays as `409 unknown`: never a
duplicate. Because the drain budget is about 11 s, set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`; the Railway
default may be shorter, and then in-flight sends would be killed (still safe, but they become `unknown`).
A second signal exits immediately.

## Messaging endpoint

1. Service, Settings, Networking: generate a domain (or attach a custom domain).
2. Register `https://<railway-domain>/api/messages` as the bot's messaging endpoint:

   ```bash
   teams app update <appId> --endpoint https://<railway-domain>/api/messages
   ```

   (Azure Bot Service registrations: Azure portal, the bot, Configuration, Messaging endpoint.)

3. Check: `curl https://<railway-domain>/healthz` returns `{"ok":true}`; a request to `/api/messages` without a
   token returns `401` (that is the SDK's validation working).

### When the domain changes

A new generated domain, a removed custom domain or a service recreated all change the host. Until the endpoint is
updated Teams cannot reach the bot: users get no link replies and `install.add` is lost (sends still work, since
stored references do not depend on the endpoint, but nothing new links). Run the `teams app update ... --endpoint`
command above with the new host, immediately. A custom domain avoids most of this and is recommended before the
pilot goes to customers. Tell Gertrude's side nothing changes: `TEAMS_BOT_URL` is the same host, so update it too
if the host changed.

## Operations notes

- Logs are JSON, one object per line: fields are `ts`, `level`, `event` and only allowlisted names (`delivery_id`,
  `status`, `code`, `reason`, `http_status`, `phase`, `route`, `duration_ms`, `count`, `port`). Nothing else can be
  logged by construction. Useful events: `reference_conflict`, `verify_failed` (`GERTRUDE_UNAUTHORIZED` is
  level `critical`), `send_failed`, `send_replayed`, `sdk_log` (the SDK complained; it prints no detail).
- Idempotency keys are purged after 45 days (the contract needs at least 30), on start and daily.
- Backups: use Railway's Postgres backups. Losing `conversation_reference` only means users must message the bot
  again; losing `send_idempotency` loses the at-most-once memory for recent deliveries.
- Rotating the two bearer tokens: change the variable on both sides in one window; there is no overlap support in
  v0, so a send in that window gets `401` (Gertrude treats it as retryable).
