# Aviary Assistant Bot

Microsoft Teams bot that delivers Aviary Assistant hypercare reports to people in Teams.

It is deliberately small: it owns the Microsoft-facing parts (the Teams app, the inbound endpoint, stored
conversation references) and nothing else. Gertrude decides who a Teams user is and what to send; this
service delivers it. No LLM, no data access, no chat features.

- Contract with Gertrude: [docs/CONTRACT.md](docs/CONTRACT.md) (the spec for every HTTP boundary)
- Build spec for v0: [docs/specs/agent-6-teams-bot-service.md](docs/specs/agent-6-teams-bot-service.md)
- Azure / Teams steps for humans: [docs/TEAMS-SETUP.md](docs/TEAMS-SETUP.md)
- Railway: [docs/RAILWAY.md](docs/RAILWAY.md)

Status: v0 implemented on `feat/bot-v0`. **Real Teams has not been run** (see "Verified and not verified").

## How it works

```
Teams ──POST /api/messages──▶ SDK (validates the Bot Framework JWT) ──▶ install.add / message / install.remove
                                                                            │ roster email (SDK client)
                                                                            ▼
                                                                  Gertrude POST /api/internal/teams/verify
                                                                            │ 200 {user_id}
                                                                            ▼
                                                              Postgres: conversation_reference (user_id → conversation)

Gertrude ──POST /v1/send (bearer + Idempotency-Key)──▶ idempotency claim ──▶ SDK API client ──▶ Teams
                                                          Postgres: send_idempotency
GET /healthz  → 200 {"ok":true} only when Postgres answers
```

One Express app carries `/api/messages` (mounted by the SDK's `ExpressAdapter`), `/v1/send` and `/healthz`.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | entrypoint: config, start, SIGTERM/SIGINT handling |
| `src/server.ts` | wiring: pool, migrations, SDK app, routes, listen, graceful stop, key purge |
| `src/config.ts` | env read once and validated with zod; errors name the variable, never the value |
| `src/sendService.ts` | `POST /v1/send`: bearer check, validation, idempotency protocol, result table |
| `src/teamsErrors.ts` | Teams / network error to contract outcome (the table below) |
| `src/teamsSender.ts` | proactive send through the SDK API client on the stored service URL |
| `src/inbound.ts` | linking rules (personal scope only, roster agrees with activity, refusals, conflicts) |
| `src/teamsApp.ts` | SDK `App` construction (inbound validation on), route glue, roster and reply ports |
| `src/gertrude.ts` | the verify call (fetch, 5 s timeout, strict response check) |
| `src/repositories.ts` | the two Postgres tables behind small interfaces |
| `src/db.ts`, `migrations/` | pool, plain SQL migrations run at start (advisory-locked), health ping |
| `src/logger.ts`, `src/serviceUrl.ts` | allowlisted JSON logger; service-URL allowlist |
| `scripts/package-app.ts`, `scripts/lib/` | Teams app package builder (manifest + placeholder icons + zip) |
| `scripts/fake-gertrude.ts`, `scripts/local-roundtrip.ts` | local fake Gertrude and the link-then-send proof |
| `test/` | Vitest suites (below) |
| `Dockerfile` | Railway build and start |

## Run it

```bash
npm ci
npm run typecheck && npm test        # needs a local Postgres, see below
npm run local:roundtrip              # link -> send with a fake Gertrude and a fake Teams sender
npm run build && npm start           # needs the env vars below
```

Tests and the round trip create and drop their own throwaway databases named `aviary_bot_test_*` /
`aviary_bot_local_*`. They connect with `TEST_PG_ADMIN_URL` / `LOCAL_PG_ADMIN_URL` (default
`postgres://bot_test:bot_test@127.0.0.1:5432/postgres`, a role with `CREATEDB` on a local server). They never touch
`DATABASE_URL`. CI runs the same against a Postgres service container.

### Environment variables (names only; see `.env.example`)

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Railway Postgres |
| `GERTRUDE_URL` | base URL of Gertrude's API |
| `GERTRUDE_VERIFY_TOKEN` | bearer the bot sends to Gertrude (`BOT_TO_GERTRUDE_TOKEN`) |
| `SEND_SERVICE_TOKEN` | bearer Gertrude sends to `/v1/send` (`GERTRUDE_TO_BOT_TOKEN`); must differ from the one above (startup refuses equal values) |
| `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` | the bot's Entra app, as the SDK expects |
| `PORT` | default 3978; Railway sets it |
| `SERVICE_URL_ALLOWED_HOSTS` | optional, extra Bot Framework service-URL hosts (default `smba.trafficmanager.net` only) |

## Decisions

### Node, not Bun

Node 22 (`engines >=22.12`, which is also the SDK's own floor). The Teams SDK runs on Node: it is plain Node
(`express`, `axios`, `jsonwebtoken`, `@azure/msal-node`), and the whole test suite drives the real SDK pipeline
(JWT validation, routing, API client) on Node 22.23. Crow's README reasons about Bun for the OpenCode SDK,
which this service does not have. Bun would add a second runtime to Railway for nothing.

### SDK version: `@microsoft/teams.apps` / `teams.api` / `teams.common` pinned exactly to 2.1.1

- 2.1.1 is the `latest` dist-tag on npm today (the `next` tag is `2.1.0-preview.3`, older than 2.1.1; `preview`
  is `2.0.0-preview.12`). Nothing newer and stable exists, so there is no upgrade case to argue. It is also what
  Crow pins.
- Pinned exactly (no caret): the inbound token validation and the API client are security-relevant, and
  upgrades should be a reviewed change, not a `npm install`.
- `@microsoft/teams.cards` is **not** installed: the bot never builds cards (contract T4: Gertrude renders the
  card, the bot passes it through unchanged).
- What this SDK version gave us that shaped the design: `ExpressAdapter` (one Express app for all routes),
  inbound JWT validation that checks signature, audience, issuer and the `serviceurl` claim against the activity,
  and `app.api.clone({ serviceUrl })`.
- Not used on purpose: `app.send(conversationId, activity)`. In 2.1.1 it builds its reference from the app-wide
  default service URL and ignores the stored one, which is wrong for regional users. The sender clones the SDK
  API client onto the stored, re-validated service URL instead. Token acquisition, headers and the connector call
  are still the SDK's.
- Known advisory: `npm audit` flags `@azure/msal-node` (GHSA-xcx6-jx8p-x3h5, authorization-code flow parameter
  disclosure) through the SDK. This service only uses the client-credentials flow, so by reading the advisory it
  is not reachable, but that is reasoned, not tested. Fixed in msal-node 7.1+, which the SDK does not accept
  yet; revisit when the SDK moves.

### Why these shapes

- **Postgres, not a file**: Railway's disk is ephemeral. Plain SQL files in `migrations/`, applied at start in a
  transaction each, under an advisory lock so two instances starting together cannot collide.
- **The SDK's own server**: the SDK's `ExpressAdapter` is given our Express app so `/healthz` and `/v1/send` sit
  next to `/api/messages`. The adapter cannot `listen()` on a user-supplied Express *function* (its `start()`
  throws and `App.start` swallows the error, so the process would stay up and not listen), so the server is
  created and listened on here, after `app.initialize()`. A test asserts the server really listens.
- **Inbound validation is never disabled.** The flags that turn it off are not set anywhere (a test greps the
  source for them), and the tests prove that missing, garbage, wrong-key, wrong-audience, wrong-issuer,
  `serviceurl`-mismatch and expired tokens all return 401 and run no handler. Test tokens are signed by a local
  JWKS server the SDK is pointed at through its own `cloud` option, so the SDK's real validation path runs.
- **At-most-once**: see the protocol below.

## `/v1/send`: how contract section 2 is implemented

Order: draining? bearer (constant-time, before the body is read) then `Idempotency-Key` UUID then zod strict body
(`card.type` is `AdaptiveCard`, serialized size at most 25 KiB) then look up the key (replay) then look up the
reference (`404 no_reference`, **key not claimed**) then claim the key then call Teams then record.

- The bearer is compared by `crypto.timingSafeEqual` on two SHA-256 digests, so the lengths always match and the
  comparison never short-circuits.
- A key already `sent` replays `200 {..., "replayed": true}` even if the reference was deleted since. A stored
  `unknown` (or a key still `in_progress`) always answers `409 unknown` and never calls Teams.
- Claiming is `INSERT ... ON CONFLICT DO NOTHING`; of two simultaneous requests one wins, the other gets `409`
  (or the replay if the winner already finished). Tested with ten at once: one Teams call.
- Time budget: the SDK HTTP client has an 8 s timeout. An outer 9 s deadline also covers bot-token acquisition. If
  the deadline passes **before** the request reaches the HTTP transport the key is released (503) and the request
  is blocked from going out late; if it passes **after**, the key becomes `unknown` and a late success never
  upgrades it.
- If Teams accepted the message but the database write that records it fails, the answer is still `200` and the
  row stays `in_progress`, which replays as `unknown`: safe, never a duplicate.
- On shutdown, sends still running past the drain deadline stay `in_progress`, which also replays as `unknown`.

### Teams error to contract outcome

The rule behind every row: the key is released (so Gertrude may retry and Teams might get a second copy) only
when the request provably was **not** accepted. Anything that might have been accepted is `unknown`.

| What happens | Bot answers | Key | Tested how |
|---|---|---|---|
| 2xx | `200 sent` (`activity_id` from Teams, `null` if absent) | `sent` | SDK client against a local fake connector |
| 403 or 404 from the connector | `403 blocked_or_uninstalled`, nothing deleted | `failed_permanent` (replayed) | fake connector |
| other 4xx (400, 413, ...) | `400 invalid_request` (generic detail) | `failed_permanent` | fake connector |
| 429 | `429 rate_limited`, `Retry-After` passed through if sane | released | fake connector |
| 503 | `503 unavailable` | released | fake connector |
| 401 from Teams (our own credentials wrong) | `503 unavailable`, critical log | released | classifier test; **reasoned**, not seen from real Teams |
| DNS failure, connection refused, TLS handshake failure | `503 unavailable` | released | connection refused for real; DNS and TLS codes by classifier test |
| token acquisition fails before dispatch | `503 unavailable` | released | classifier test |
| deadline passes before dispatch | `503 unavailable` | released | fake sender (late dispatch is blocked) |
| 500, 502, 504, 408, any 3xx or unmapped status | `409 unknown` | `unknown` | 500/502/504 against fake connector; others classifier |
| timeout after dispatch, connection reset, `ETIMEDOUT`, `EPIPE`, any error with no mapping | `409 unknown` | `unknown` | reset and hang against fake connector |

Judgement calls, challenge them: only 429 and 503 count as "provably not accepted". A 500/502/504 does not prove
Teams did not accept the activity (504 especially), so it is `unknown`; the cost is some false `unknown`
deliveries. A connection reset on a reused keep-alive socket is often pre-write but cannot be proven, so it is
`unknown` too. What was only **reasoned from the docs and the SDK's code** and not observed from real Teams: which
status the connector returns for a user who uninstalled, blocked the bot or never installed (403 vs 404), what it
returns for throttling, and the 401 case.

## Inbound rules (contract section 3 and 4)

- Only a personal-scope one-to-one conversation links. Group chats, channels and team installs get "This bot only
  works in a personal chat." and store nothing.
- The email comes from the Bot Framework roster for that member (`GET /v3/conversations/{id}/members/{id}` on the
  activity's service URL). The roster `aadObjectId` must equal the activity's, the roster tenant (if present) and
  the two tenant fields on the activity must agree, or nothing is stored and Gertrude is not asked. Only the
  roster `email` is used, not `userPrincipalName`, to keep matching exact. Matching is case-insensitive via
  lower-casing; Gertrude does the actual match.
- `REFERENCE_CONFLICT`: one atomic upsert refreshes a row only when tenant and object id are unchanged; otherwise
  the old row is kept, `REFERENCE_CONFLICT` is logged with a reason word only, and the user gets the polite
  refusal. The mirror case (the same Teams identity already linked to a *different* `user_id`, for example after
  an email change) hits the unique `(tenant_id, aad_object_id)` index and is refused the same way; an operator
  deletes the stale row.
- `install.remove` deletes by `(tenant, object id)` from the authenticated activity, personal scope only.
- Every personal message re-runs the link and answers with the same one-line result (linked, not set up, or
  temporary failure): "Anything else a user types gets that same one-line help."
- The service URL is stored from the authenticated activity and checked again before every send: `https`, no
  userinfo, no port, host on the allowlist. The bot token goes to that host, so an unvalidated URL would leak it.
- Replies and roster calls go through the SDK API client, pinned to the validated service URL.

## Tests

`npm test` runs 14 files, about 260 cases, against a real Postgres, with fakes for everything Microsoft:

| Suite | Covers |
|---|---|
| `send.contract` | every row of the section 2 table, replays, key release, `unknown` never retried, concurrent same-key race |
| `send.auth` | missing / wrong / right bearer; `timingSafeEqual` is used on equal-length digests |
| `send.sdk`, `teamsErrors` | the real SDK client against a fake Bot Connector; error mapping |
| `inbound`, `inbound.auth` | fake Gertrude (200, 404, 401, 500, timeout, reset, malformed), personal / group / channel, roster mismatch, `REFERENCE_CONFLICT`, reinstall, `install.remove`; SDK token validation with real signatures |
| `repositories` | both tables and the idempotency state machine on real Postgres; migrations |
| `lifecycle`, `process` | `/healthz`, listening, graceful shutdown, real process SIGTERM, bad config exit |
| `logger`, `stdout`, and an `afterAll` in every HTTP suite | no token, email, user id, tenant or object id, conversation id, service URL or card text in any log line, nor in anything the SDK prints |
| `config`, `serviceUrl`, `manifest` | missing variable named, value never; allowlist; manifest validated against the committed Microsoft v1.30 JSON schema |

Mutation spot-checks (removing the roster check, the conflict guard, the `unknown` marker, the constant-time
compare, the late-dispatch guard, the personal-scope guard, the SDK logger) each make a test fail.

## Teams app package

`CLIENT_ID=<bot app id> npm run package:app` writes `appPackage/build/` (git-ignored): `manifest.json`, two icons
and `aviary-assistant.zip`. Personal scope only; no `webApplicationInfo`, no resource-specific consent, no
`ChannelMessage.Read.Group`, no `validDomains`; name "Aviary Assistant"; manifest schema 1.30 (the current one,
August 2026); the app `id` is `43d89c2d-145f-480a-bea7-39566082fb4e`, a fresh UUID of ours.
**The icons are generated placeholders** (a teal square with a white disc, and a white ring); design will supply
the real ones. The developer name and website, privacy and terms URLs default to `example.com` placeholders and
must be replaced (`APP_DEVELOPER_NAME`, `APP_WEBSITE_URL`, `APP_PRIVACY_URL`, `APP_TERMS_URL`) before anyone
outside the team sees the app.

## Verified and not verified

| Verified here (automated, on Node 22 and Postgres 16) | Not verified (needs real Teams) |
|---|---|
| The SDK's inbound validation rejects missing, garbage, wrong-key, wrong-audience, wrong-issuer, mismatching-`serviceurl` and expired tokens, and accepts a correctly signed one (local JWKS) | That **Microsoft's real tokens** pass that path: the real issuer, keys, claims and the `serviceurl` format Teams sends |
| Link, refuse, conflict, reinstall and uninstall flows, driven through the real SDK pipeline | The **roster call returns the email** for a real user, and in which tenants it does not |
| `/v1/send` contract, idempotency, concurrency, shutdown, logging hygiene | **Proactive send to a user with no prior message**: that the conversation id captured at `install.add` can be messaged before the user ever writes. This is how Teams documents proactive messaging for installed apps, but it was not run |
| SDK client behaviour on 4xx/5xx/reset/hang (against a local fake connector) | What the **real connector** returns for blocked, uninstalled and throttled (the status mapping is reasoned) |
| Production dependencies are complete (`npm ci --omit=dev`, `node dist/main.js`, SIGTERM) | The **Docker image** (no Docker on the build machine; the same steps were run by hand) and anything on **Railway** |
| Manifest validates against the Microsoft 1.30 schema | That Teams **accepts and installs** the package; that `teams app manifest upload` accepts our app id (see TEAMS-SETUP) |
| | **Customer tenants**: whether a Teams-managed single-tenant bot can message users in a customer's own tenant. Not known; the spike is in [docs/TEAMS-SETUP.md](docs/TEAMS-SETUP.md) |
| | The real `CLIENT_SECRET` token flow through MSAL (tests inject a token provider) |

## Where this differs from, or adds to, the spec

- `send_idempotency` has one extra nullable column, `outcome` (`blocked_or_uninstalled` | `invalid_request`), so a
  stored `failed_permanent` can be replayed as the same status. Without it the given schema cannot say which one
  to replay. Both tables also have `not null` on the timestamps.
- `no_reference` and `400` validation answers are not stored: nothing was sent, so there is no at-most-once risk,
  and a retry after the user installs the bot can succeed. The contract's "stored per key" list is read as
  covering Teams-side outcomes.
- `activity_id` is `null` in a `200` if Teams returned no id; the contract shows a string. Gertrude should accept
  `null` (or treat it as an empty provider id).
- `CONTRACT.md` could otherwise be implemented as written. Two points it leaves open are resolved above: which
  5xx count as "provably not accepted" (503 only), and that a reused `Idempotency-Key` for a different `user_id`
  is a `400`.
- Adds optional `SERVICE_URL_ALLOWED_HOSTS` to the listed variables.
