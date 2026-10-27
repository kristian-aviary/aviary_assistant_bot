Use Opus 5.5 as advisor, rely on it when necessary, use Haiku subagents efficiently (not just one subagent unless that makes sense).

# Agent 6: The Aviary Teams bot service (new repo)

Repo `kristian-aviary/aviary_assistant_bot` (GitHub, was empty; the first commit on `main` is
scaffolding only: README, `.gitignore`, and `docs/`). Local checkout:
`/Users/kristianfischer/Development/aviary_assistant_bot`. Work on branch `feat/bot-v0` and open a
PR into `main`. Hosted on Railway.

## Why this exists

Hypercare reports are delivered to people by email and in Microsoft Teams. Teams needs a bot
registration, a public HTTPS endpoint and a stored conversation reference per user. We keep that out of
Gertrude: this service owns the Microsoft-facing parts, and Gertrude calls it over HTTP. Your boss
asked for a separate repo; this is it.

The Gertrude side (the client channel, the verify endpoint and Terraform) is built in parallel by
agent 7 against the same contract. Do not touch Gertrude.

## Read first (in this order)

1. `docs/CONTRACT.md` in this repo, a copy of `docs/hypercare/s2/TEAMS-BOT-CONTRACT.md` from Gertrude.
   **It is the spec for every HTTP boundary.** Sections 1 to 4.
2. The reference scaffold from your boss's internal bot, code only (no secrets), at
   `/Users/kristianfischer/Development/wt/_crow_ref/crow-in-teams/`: `src/bot.ts` (handlers: `install.add`,
   `message`, proactive `app.send(conversationId, activity)`), `src/cards.ts`, `src/package-app.ts`
   (manifest and zip), `README.md` (devtunnel, `teams app create`, install flow), `package.json`.
   **Crow is a different product**: internal only, an LLM agent with data access, sideloaded in one
   tenant. Reuse the SDK usage and the packaging pattern, not the agent, MCP, Notion, scheduler,
   OpenCode, JSON-file store or its manifest permissions.
3. A previous attempt that was **not** merged, as reference for rules and tests only, at
   `/Users/kristianfischer/Development/wt/s2-teams/src/reports/channels/teams/`: `inboundService.ts` (which
   conversations are allowed to link, the roster-agrees-with-activity rule, refusal wording),
   `botConnectorAdapter.ts` (error to outcome mapping), `docs/hypercare/s2/teams-bot-setup.md` (an
   Azure and Teams checklist). It hand-rolled Bot Framework JWT validation with `jose` and called the
   REST API with `fetch`. **Do not copy that approach.** Use Microsoft's SDK, which validates inbound
   tokens for you.
4. Microsoft's Teams SDK documentation for the version you pin (`@microsoft/teams.apps`,
   `@microsoft/teams.api`, `@microsoft/teams.cards`; Crow pins 2.1.1, check for a newer stable
   release and justify the pin in the README).

## Build

### Service

- TypeScript, strict. Start on Node 22+; use Bun only if the Teams SDK genuinely does not run on Node
  (Crow's README says Bun was needed for the OpenCode SDK, not for the Teams SDK; verify, do not assume).
  Express or the SDK's own HTTP server, whichever lets you mount `GET /healthz` and `POST /v1/send` next
  to the SDK's `/api/messages`.
- **Postgres** (Railway) for state. Not a JSON file: Railway's filesystem is ephemeral. Plain SQL
  migrations run at start (or a small migration command), no ORM required. Tables:
  - `conversation_reference(user_id text primary key, tenant_id text not null, aad_object_id text not null,
    conversation_id text not null, service_url text not null, reference jsonb not null,
    created_at timestamptz default now(), updated_at timestamptz default now())`, with a unique index on
    `(tenant_id, aad_object_id)`.
  - `send_idempotency(key uuid primary key, user_id text not null, status text not null, activity_id text,
    created_at timestamptz default now(), updated_at timestamptz default now())`, status one of
    `in_progress | sent | failed_permanent | unknown`.
- **Inbound (Teams to bot)**, via the SDK at `/api/messages`:
  - On `install.add` and on a personal-scope `message`: establish the user's email (contract section 4),
    call Gertrude `POST /api/internal/teams/verify`, and on `200` store or refresh the reference for the
    returned `user_id` (rules in contract section 3, including the `REFERENCE_CONFLICT` refusal). Reply
    once, briefly: linked ("You will receive Aviary Assistant reports here.") or not set up (polite
    refusal, no detail). Anything else a user types gets that same one-line help; no chat features.
  - Ignore everything that is not a personal-scope one-to-one conversation (group chats, channels,
    team installs): reply that this bot only works in a personal chat and store nothing.
  - On `install.remove` (if the SDK delivers it): delete the reference for that user.
  - **Do not disable or bypass the SDK's inbound token validation** for any reason, including local
    development. For local tests use the SDK's own testing facilities or inject a fake client at the
    boundary.
- **Outbound (`POST /v1/send`)**: exactly contract section 2: bearer check (constant-time compare),
  strict body validation (zod), the idempotency protocol, the result table. Send the card as an Adaptive
  Card attachment with `fallback_text` as the message text, via the SDK's proactive send to the stored
  conversation (`app.send(conversation_id, activity)` as in Crow). Map Teams errors to the contract
  outcomes: not installed or blocked (403-class) to `blocked_or_uninstalled` and delete nothing;
  `429` or a provably-not-accepted transient failure to retryable; **ambiguous** (timeout, connection
  lost after the request was written) to `unknown`.
- `GET /healthz`: `200 {"ok":true}` only when the database answers; no secrets in the body.
- Config from env, read at start and validated with zod, with a clear failure message naming the missing
  variable (never its value): `DATABASE_URL`, `GERTRUDE_URL`, `GERTRUDE_VERIFY_TOKEN`,
  `SEND_SERVICE_TOKEN`, the Teams credentials the SDK needs (`CLIENT_ID`, `CLIENT_SECRET`,
  `TENANT_ID`, as in Crow), `PORT`.
- Graceful shutdown on `SIGTERM` (Railway sends it): stop accepting, finish in-flight sends, close the pool.
- Structured JSON logs. **Never log** cards, report text, emails, user ids, tenant ids, object ids,
  conversation ids, service URLs, or tokens. Delivery ids (the idempotency key), status words and error
  codes only.

### Teams app package

- A script like Crow's `package-app.ts` that builds `manifest.json` and zips it with icons. Differences
  from Crow, all required: personal scope only; **no** `webApplicationInfo` and **no** resource-specific
  consent or `ChannelMessage.Read.Group`; name "Aviary Assistant"; valid domains empty; manifest version
  per the current schema; the app `id` must be a fresh UUID of ours, not Crow's. Icons: generate simple
  placeholders and say so in the README (design will supply real ones).
- Docs for the humans doing the Azure and Teams steps (`docs/TEAMS-SETUP.md`): registering with the
  `teams` CLI as in Crow's README (Teams-managed bot, no Azure subscription) or Azure Bot Service if the
  CLI route cannot serve customer tenants; devtunnel for local runs; sideloading; tenant admin consent;
  what changes for a recipient in a customer's tenant. Mark each step **required** or **optional** for the
  pilot. **State plainly that whether a Teams-managed single-tenant bot can message users in a customer's
  own tenant has not been verified, and give the smallest spike that would settle it** (a second test
  tenant).

### Railway

`docs/RAILWAY.md`: service, Postgres plugin, env vars (list, no values), health check path, start command,
how `SIGTERM` is handled, how to set the messaging endpoint
(`https://<railway-domain>/api/messages`) in the registration, and what to do when the domain changes
(`teams app update ... --endpoint`, as in Crow's README). Add whatever file Railway needs to build and
start (`railway.json` or a `Dockerfile`; pick one and say why). Do not deploy.

## Tests (Vitest)

- Contract tests for `/v1/send` against a **fake Teams sender**: every row of the section 2 table
  (including `409 unknown`, replay of a stored `sent`, replay of a stored `unknown` that must never call
  the sender again, key release after a clean transient failure, and the concurrent same-key race: two
  simultaneous requests produce one Teams call).
- Auth: missing, wrong and right bearer on `/v1/send`; the comparison is constant-time.
- Inbound: a fake Gertrude (HTTP server in the test) answering `200`, `404`, `401`, `500`, and timeout;
  personal vs group vs channel; roster `aadObjectId` mismatch stores nothing; `REFERENCE_CONFLICT` keeps
  the old row; reinstalling refreshes the row; `install.remove` deletes it.
- Repository tests against a real Postgres (use the throwaway local database, a separate database name,
  never a shared one) for both tables, including the idempotency state machine.
- A test that asserts no log line contains a token, email, user id or card text (spy on the logger
  across the whole inbound and outbound suites).
- Config: missing variables name the variable and not the value.

## Local run (required)

1. Run the bot against a local Postgres and a fake Gertrude (a small script in `scripts/`, committed;
   this one is ours, not a secret) and prove a link-then-send round trip with the fake Teams sender.
2. If, and only if, the user has already supplied Teams credentials and a tunnel, say so and do a real
   install; otherwise state "real Teams not run" and list what that needs. Do not look for credentials in
   other repositories or in Crow's files.

## Out of scope

Chat or Q&A, LLM, MCP, Notion, scheduling, channels and group chats, SSO, the Gertrude side, real
deployment to Railway, registering the app in Azure or Teams (document it), proactive onboarding of
users who have not installed the bot.

## Report

Files and structure; the Node or Bun decision and why; the SDK version pinned and why; env vars (names
only); how Teams errors map to contract outcomes (a table, and what was only reasoned from the docs
versus tested); the verified-vs-unverified list (be specific: inbound token validation path, proactive
send to a user with no prior message, customer tenants); anything in `CONTRACT.md` you could not
implement as written.
