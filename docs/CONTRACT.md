# Teams bot contract (`teams-bot-v1`)

Supersedes section 6 of `CONTRACT-ADDENDUM.md` (the in-process Teams channel from the old agent 5
was never merged). Shared by two builds that run in parallel: the **bot service**
(`kristian-aviary/aviary_assistant_bot`, hosted on Railway) and the **Gertrude client**
(`gertrude`, branch `kfischer/dev-1919-s2-teams-client`). If a spec and this file disagree, this
file wins; if you think it is wrong, stop and say so in your final report.

## 1. Decisions (do not revisit)

| # | Decision |
|---|---|
| T1 | The bot is a **separate service and repo**. Gertrude never imports Microsoft code and holds no Teams credentials. |
| T2 | **Gertrude is the identity authority.** Only Gertrude decides which Assistant `user_id` a Teams user is. The bot never reads Gertrude's database. |
| T3 | **The bot owns conversation references** (its own Postgres on Railway), keyed by Assistant `user_id`. Gertrude has no Teams table and there is **no migration 0019**. |
| T4 | **Gertrude renders the card.** The bot is a pipe: it never sees the report contract and never calls an LLM, the MCP server or any other Aviary service. |
| T5 | Two service-to-service bearer tokens, one per direction (below). Never the same value, never logged. |
| T6 | Delivery stays **at-most-once**. The bot enforces it with an idempotency key; Gertrude maps ambiguous outcomes to `unknown` and never auto-resends. |
| T7 | One-to-one (personal scope) only in v0. No channels, no group chats, no Q&A in Teams. |
| T8 | This bot is **not** Crow (`crow-in-teams`). Crow is internal-only with a token that can read every client; this bot is customer-facing and holds no data access. Separate Teams app registration. Code and patterns may be reused; credentials, `.env` and `data/` never. |

## 2. Gertrude to bot: send

`POST {TEAMS_BOT_URL}/v1/send`

Headers: `Authorization: Bearer <GERTRUDE_TO_BOT_TOKEN>`, `Idempotency-Key: <delivery_id>` (a UUID),
`Content-Type: application/json`.

```json
{
  "user_id": "samlp|aviary|someone@example.com",
  "card": { "type": "AdaptiveCard", "version": "1.5", "body": [ "..." ], "actions": [ "..." ] },
  "fallback_text": "Plain text shown where cards are not supported"
}
```

`card` is passed through to Teams unchanged after validation (object, `type` is `AdaptiveCard`,
serialized size at most 25 KB). The bot does not interpret it.

| Bot answers | Body | Meaning for Gertrude (`DeliveryResult`) |
|---|---|---|
| `200` | `{"status":"sent","activity_id":"..."}` | `sent`, `provider_message_id = activity_id` |
| `200` | same, plus `"replayed":true` | The key was already sent; same as `sent` (never sends twice) |
| `404` | `{"status":"no_reference"}` | `failed_permanent`, `RECIPIENT_NOT_ELIGIBLE`: the user has not installed or opened the bot |
| `403` | `{"status":"blocked_or_uninstalled"}` | `failed_permanent`, `RECIPIENT_NOT_ELIGIBLE` |
| `400` | `{"status":"invalid_request","detail":"..."}` | `failed_permanent`, `DELIVERY_PROVIDER_ERROR` (a bug on our side) |
| `401` | `{"status":"unauthorized"}` | `failed_retryable`, `DELIVERY_PROVIDER_ERROR` (configuration fault) |
| `429` | `{"status":"rate_limited"}`, optional `Retry-After` | `failed_retryable`, `DELIVERY_PROVIDER_ERROR` |
| `502`/`503`/`504`, `5xx` that is **not** `unknown` | `{"status":"unavailable"}` | `failed_retryable`, `DELIVERY_PROVIDER_ERROR` |
| `409` | `{"status":"unknown"}` | `unknown`, `DELIVERY_UNKNOWN`: the bot could not tell whether Teams accepted it |
| timeout, connection reset after the request was written, any unexpected response | | `unknown`, `DELIVERY_UNKNOWN` |
| failure before the request is written (missing config, DNS) | | `failed_retryable`, never `unknown` |

Idempotency rules (bot side):
- The key is claimed **before** Teams is called. A second request with the same key while the
  first is in flight answers `409 unknown`; after the first finished it replays the stored result.
- Outcome stored per key: `sent` (with activity id), `failed_permanent` (404/403/400-class, replayed
  as the same status), `unknown` (Teams call was ambiguous: timeout or connection loss after the
  request was written; always replayed as `409 unknown`, never retried).
- A clean transient failure (Teams `429` or `5xx` where the request provably was not accepted)
  releases the key so Gertrude's retry can send again.
- Keys are kept for at least 30 days.

Timeouts: Gertrude waits at most 10 s. The bot waits at most 8 s on Teams.

## 3. Bot to Gertrude: verify (link a Teams user to an Assistant user)

`POST {GERTRUDE_URL}/api/internal/teams/verify`

Headers: `Authorization: Bearer <BOT_TO_GERTRUDE_TOKEN>`, `Content-Type: application/json`.

```json
{ "tenant_id": "<Entra tenant id>", "aad_object_id": "<Entra object id>", "email": "person@example.com" }
```

| Gertrude answers | Body | Bot behaviour |
|---|---|---|
| `200` | `{"user_id":"samlp|aviary|someone@example.com"}` | Store or refresh the reference for that `user_id` |
| `404` | `{"error":"NOT_FOUND"}` | Reply politely that this account is not set up for Aviary reports; store nothing |
| `401` | `{"error":"UNAUTHORIZED"}` | Log a critical configuration error; reply with a generic temporary-failure message; store nothing |
| `429`/`5xx`/timeout | | Reply with a generic temporary-failure message; store nothing; do not retry in a loop |

Gertrude answers `404` identically for: no user with that email, more than one user with that email,
and a tenant that is not allowed (`TEAMS_ALLOWED_TENANT_IDS`). The response never says which.
Matching is exact on lower-cased email. The body is validated strictly (unknown keys rejected).

Bot-side rule (the one thing the bot decides): if a reference already exists for that `user_id`
with a **different** `aad_object_id`, do **not** overwrite it. Refuse, log `REFERENCE_CONFLICT` with
no identifiers, and keep the existing row. Removing a stale row is a deliberate operator action.

## 4. Operational contract

- **Where the email comes from.** Teams activities carry `aadObjectId` and a display name but not the
  email. The bot gets the email from the Bot Framework roster or Graph for that conversation member
  and must check that the roster entry's `aadObjectId` equals the activity's. If the email cannot be
  established it asks nothing of Gertrude and stores nothing.
- **Health.** The bot exposes `GET /healthz` (no auth, no secrets, `200 {"ok":true}` when the database
  answers). Gertrude does not call it.
- **No PII in logs on either side.** Never log report text, cards, emails, user ids, tenant ids,
  object ids, conversation ids, service URLs or tokens. Delivery ids, run ids, status words and error
  codes only.
- **Configuration.**
  - Gertrude: `TEAMS_BOT_URL`, `TEAMS_BOT_SERVICE_TOKEN` (this is `GERTRUDE_TO_BOT_TOKEN`) on the
    delivery worker; `TEAMS_BOT_VERIFY_TOKEN` (this is `BOT_TO_GERTRUDE_TOKEN`) and
    `TEAMS_ALLOWED_TENANT_IDS` (comma separated) on the API.
  - Bot: `GERTRUDE_URL`, `GERTRUDE_VERIFY_TOKEN` (= `BOT_TO_GERTRUDE_TOKEN`), `SEND_SERVICE_TOKEN`
    (= `GERTRUDE_TO_BOT_TOKEN`), plus the Teams credentials and `DATABASE_URL`.
- **Versioning.** Paths carry `/v1/`. Additive response fields are allowed; consumers ignore unknown
  fields. Anything else is a `/v2/`.
