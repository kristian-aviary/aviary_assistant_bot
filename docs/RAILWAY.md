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
2. Run **exactly one replica**. The idempotency guard is in memory and per process, so a second replica would have
   its own empty guard. See [Replicas and deploys](#replicas-and-deploys).
3. No volume. The service keeps no state on disk, and there is no database in this project: no database plugin,
   no `DATABASE_URL`, no migrations.

### Variables (names only; no values here)

| Variable | Source |
|---|---|
| `GERTRUDE_URL` | Gertrude's API base URL |
| `GERTRUDE_VERIFY_TOKEN` | bearer the bot presents to Gertrude; same value as Gertrude's `TEAMS_BOT_VERIFY_TOKEN` (`BOT_TO_GERTRUDE_TOKEN`) |
| `SEND_SERVICE_TOKEN` | bearer Gertrude presents to `POST /v1/send`; same value as Gertrude's `TEAMS_BOT_SERVICE_TOKEN` (`GERTRUDE_TO_BOT_TOKEN`); must differ from `GERTRUDE_VERIFY_TOKEN` (startup refuses equal values) |
| `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` | the bot registration (see [TEAMS-SETUP.md](TEAMS-SETUP.md)) |
| `SERVICE_URL_ALLOWED_HOSTS` | optional; comma separated extra Bot Framework service URL hosts; default `smba.trafficmanager.net` |
| `PORT` | set by Railway; do not set it yourself |

Startup fails with `Invalid configuration: missing <NAME>` (exit 1, no values printed) if one is absent, and the
deploy is marked failed.

### Health check

Settings, Deploy, Healthcheck Path: `/healthz`. It answers `200 {"ok":true}` while the process is serving. It is
unauthenticated and has no database check, because there is no database.

### Start command

Leave it empty: the Dockerfile's `CMD ["node", "dist/main.js"]` is used.

## Replicas and deploys

- **One replica only.** The idempotency guard that stops a send from going to Teams twice lives in process memory.
  Two replicas would each keep their own guard, so the at-most-once protection would no longer hold.
- **No overlap.** A deploy must not run the new instance alongside the old one for the same reason. Use stop-then-start:
  the old instance is stopped before the new one serves. Do not rely on a zero-downtime overlap.
- Gertrude retries only failures that the bot did not accept, and it answers new requests with `503 unavailable`
  while it is shutting down, so a short gap during a deploy is safe. See [SIGTERM](#sigterm).

## State is lost on restart

The bot keeps its idempotency guard in memory only. A restart or redeploy empties it. That is acceptable:

- Gertrude never retries an `unknown` outcome. It retries only failures that the bot did not accept (the explicit
  `failed_retryable` answers and failures before the request was written). A connection lost mid-request is
  `unknown` on Gertrude's side, so it is not retried.
- Gertrude owns the conversation reference in its own database. Nothing about who-to-message is lost on restart,
  because the bot never stored it.
- A restart can allow a duplicate only if Gertrude re-sent the same delivery (same `Idempotency-Key`) after the
  bot had lost its record. Gertrude's at-most-once delivery state prevents that re-send, so this is not expected
  to happen.

## SIGTERM

Railway sends `SIGTERM` to a deployment when it is replaced or stopped, then `SIGKILL` after the draining time.
The service handles `SIGTERM` (and `SIGINT`):

1. `/v1/send` immediately answers `503 unavailable` for anything new, and claims no keys, so Gertrude retries.
2. The listener closes; idle connections are dropped, busy ones finish.
3. In-flight sends are awaited for up to 10 s (the Teams call itself is capped at 8 s).
4. A short flush, remaining sockets are cut, exit 0.

A send still running at the deadline is cut off with its connection. Gertrude sees a connection lost after the
request was written, which is `unknown`, and it never retries that. Because the drain budget is about 11 s, set the
Railway service setting `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`; the Railway default may be shorter, and then
in-flight sends would be killed (still safe, but they become `unknown`).
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
Gertrude holds the conversation reference and does not depend on the endpoint, but nothing new links). Run the
`teams app update ... --endpoint` command above with the new host, immediately. A custom domain avoids most of
this and is recommended before the pilot goes to customers. Tell Gertrude's side nothing changes: `TEAMS_BOT_URL`
is the same host, so update it too if the host changed.

## Operations notes

- Logs are JSON, one object per line: fields are `ts`, `level`, `event` and only allowlisted names (`delivery_id`,
  `status`, `code`, `reason`, `http_status`, `phase`, `route`, `duration_ms`, `count`, `port`). Nothing else can be
  logged by construction. Useful events include `link_result` (code `REFERENCE_CONFLICT`), `send_failed`, `send_replayed`, and `sdk_log`
  (the SDK complained; it prints no detail). `GERTRUDE_UNAUTHORIZED` is level `critical`.
- Idempotency keys are held in memory only, for 24 hours, and are lost on restart (see
  [State is lost on restart](#state-is-lost-on-restart)).
- Rotating the two bearer tokens: change the variable on both sides in one window; there is no overlap support in
  v0, so a send in that window gets `401` (Gertrude treats it as retryable).
