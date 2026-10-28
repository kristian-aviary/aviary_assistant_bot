# Teams bot contract (`teams-bot-v2`), bot-side copy

This file is the bot-side copy of `teams-bot-v2`. The authoritative file is `docs/hypercare/s2/TEAMS-BOT-CONTRACT.md`
in the `gertrude` repo. If the two disagree, the Gertrude file wins; if you think it is wrong, stop and say so
in your report and do not change this copy on your own.

Sections 2 to 5 are copied from the authoritative file. Section 1 (decisions, T1 to T9) is not copied here; read it
in the Gertrude file.

## 2. Gertrude to bot: send

`POST {TEAMS_BOT_URL}/v1/send`

Headers: `Authorization: Bearer <GERTRUDE_TO_BOT_TOKEN>`, `Idempotency-Key: <delivery_id>` (a UUID),
`Content-Type: application/json`.

```json
{
  "conversation_id": "a:1AbC...",
  "service_url": "https://smba.trafficmanager.net/amer/",
  "card": { "type": "AdaptiveCard", "version": "1.5", "body": [ "..." ], "actions": [ "..." ] },
  "fallback_text": "Plain text shown where cards are not supported"
}
```

`conversation_id` and `service_url` are the two columns Gertrude stored when the user opened the bot.
The body is strict: unknown keys are rejected. There is no `user_id` and no `reference`.

The bot **re-validates `service_url` on every send** against its own allowlist
(`SERVICE_URL_ALLOWED_HOSTS`, https only, same normalization as at install) and refuses anything else
with `400 invalid_request`. The bot attaches a bearer token when it calls that URL, and the value now
arrives over the network from a database it does not control, so it is never trusted. `conversation_id`
must be a non-empty string of at most 512 characters.

`card` is passed through to Teams unchanged after validation (object, `type` is `AdaptiveCard`,
serialized size at most 25 KB). The bot does not interpret it.

| Bot answers | Body | Meaning for Gertrude (`DeliveryResult`) |
|---|---|---|
| `200` | `{"status":"sent","activity_id":"..."}` | `sent`, `provider_message_id = activity_id` |
| `200` | same, plus `"replayed":true` | The key was already sent; same as `sent` (never sends twice) |
| `403` | `{"status":"blocked_or_uninstalled"}` | `failed_permanent`, `RECIPIENT_NOT_ELIGIBLE` |
| `400` | `{"status":"invalid_request","detail":"..."}` | `failed_permanent`, `DELIVERY_PROVIDER_ERROR` (a bug on our side) |
| `401` | `{"status":"unauthorized"}` | `failed_retryable`, `DELIVERY_PROVIDER_ERROR` (configuration fault) |
| `429` | `{"status":"rate_limited"}`, optional `Retry-After` | `failed_retryable`, `DELIVERY_PROVIDER_ERROR` |
| `502`/`503`/`504`, `5xx` that is **not** `unknown` | `{"status":"unavailable"}` | `failed_retryable`, `DELIVERY_PROVIDER_ERROR` |
| `409` | `{"status":"unknown"}` | `unknown`, `DELIVERY_UNKNOWN`: the bot could not tell whether Teams accepted it |
| timeout, connection reset after the request was written, any unexpected response | | `unknown`, `DELIVERY_UNKNOWN` |
| failure before the request is written (missing config, DNS) | | `failed_retryable`, never `unknown` |

There is **no** `404 no_reference` any more. **Gertrude decides eligibility itself:** the Teams handler
looks up the stored reference for the delivery's `user_id` before calling the bot, and when there is no
row it returns `failed_permanent` / `RECIPIENT_NOT_ELIGIBLE` without making a request.

Idempotency (bot side, in memory, v0):
- The key is claimed **before** Teams is called. A second request with the same key while the first is in
  flight answers `409 unknown`; after the first finished it replays the stored result.
- Outcome stored per key: `sent` (with activity id), `failed_permanent` (403/400-class, replayed as the
  same status), `unknown` (Teams call was ambiguous: timeout or connection loss after the request was
  written; always replayed as `409 unknown`, never retried).
- A clean transient failure (Teams `429` or `5xx` where the request provably was not accepted) releases
  the key so Gertrude's retry can send again.
- A replay whose `conversation_id` differs from the one first used for that key answers
  `400 invalid_request`.
- Keys are kept for 24 hours (bounded map, entries evicted by age; a hard cap on entries, oldest first).
- State is lost on restart. That is acceptable because Gertrude never retries `unknown`, only explicit
  pre-dispatch failures, and a connection lost mid-request is `unknown` on Gertrude's side.

Timeouts: Gertrude waits at most 10 s. The bot waits at most 8 s on Teams.

## 3. Bot to Gertrude: link a Teams user (create or refresh the reference)

`PUT {GERTRUDE_URL}/api/internal/teams/reference`

Headers: `Authorization: Bearer <BOT_TO_GERTRUDE_TOKEN>`, `Content-Type: application/json`.

```json
{
  "tenant_id": "<Entra tenant id>",
  "aad_object_id": "<Entra object id>",
  "email": "person@example.com",
  "conversation_id": "a:1AbC...",
  "service_url": "https://smba.trafficmanager.net/amer/",
  "reference": { "channelId": "msteams", "serviceUrl": "...", "conversation": { "id": "...", "conversationType": "personal", "tenantId": "..." }, "bot": { "id": "..." }, "user": { "id": "...", "aadObjectId": "..." } }
}
```

This one call replaces v1's `verify`: Gertrude both decides who the person is and stores the reference.

Gertrude, in this order:
1. Checks the bearer in constant time **before reading the body**. Missing or wrong, or the variable
   unset: `401 {"error":"UNAUTHORIZED"}`.
2. Validates the body strictly (unknown keys rejected): `tenant_id` and `aad_object_id` non-empty,
   at most 128 characters, stored lower-cased; `email` a plausible address, at most 320 characters;
   `conversation_id` at most 512; `service_url` an `https:` URL of at most 2048 characters; `reference` a
   JSON object whose serialized size is at most 16 KB. Invalid: `400 {"error":"INVALID_REQUEST"}`.
3. Resolves the Assistant user: exact match on lower-cased email against the `user` table, and
   `tenant_id` must be in `TEAMS_ALLOWED_TENANT_IDS`. **Zero users, more than one user, and a tenant that
   is not allowed all answer the same `404 {"error":"NOT_FOUND"}`**; the response never says which.
4. Stores the row with a single atomic statement (insert, or update **only when the existing row has the
   same `tenant_id` and `aad_object_id`**). A row for that `user_id` that belongs to a different Teams
   identity, or an identity already bound to a different `user_id` (the `(tenant_id, aad_object_id)`
   unique key), is a conflict: nothing is changed and Gertrude answers `409 {"error":"CONFLICT"}`.
   Removing a stale row is a deliberate operator action.
5. Success: `200 {"status":"created"}` or `200 {"status":"refreshed"}`.

Bot behaviour:

| Gertrude answers | Bot behaviour |
|---|---|
| `200` | Reply that reports will arrive here |
| `404` | Reply politely that this account is not set up for Aviary reports; nothing was stored |
| `409` | Same reply as `404`; log `REFERENCE_CONFLICT` with no identifiers |
| `401` | Log a critical configuration error; generic temporary-failure reply |
| `400` | Log an error (a bug on our side); generic temporary-failure reply |
| `429`/`5xx`/timeout | Generic temporary-failure reply; do not retry in a loop |

## 4. Bot to Gertrude: unlink (the user uninstalled the bot)

`POST {GERTRUDE_URL}/api/internal/teams/reference/remove`

Same headers and the same auth-before-body rule. Body (strict): `{ "tenant_id": "...", "aad_object_id": "..." }`,
both lower-cased by Gertrude. It deletes the row with that `(tenant_id, aad_object_id)` and answers
`200 {"removed":true}` or `200 {"removed":false}` (idempotent, never a 404, so it reveals nothing).
`401` and `400` as above. No allowed-tenant check is needed (it can only delete what matches exactly).
A POST rather than a DELETE with a body, so no client or proxy has to carry a body on DELETE and nothing
identifying goes in a URL.

## 5. Operational contract

- **Where the email comes from.** Teams activities carry `aadObjectId` and a display name but not the
  email. The bot gets the email from the Bot Framework roster or Graph for that conversation member
  and must check that the roster entry's `aadObjectId` equals the activity's, and that its tenant
  equals the activity's. If the email cannot be established it asks nothing of Gertrude and stores
  nothing. (Unchanged from v1.)
- **Health.** The bot exposes `GET /healthz` (no auth, no secrets, `200 {"ok":true}` while the process
  is serving). It no longer checks a database. Gertrude does not call it.
- **No PII in logs on either side.** Never log report text, cards, emails, user ids, tenant ids,
  object ids, conversation ids, service URLs, reference JSON or tokens. Delivery ids, run ids, status
  words and error codes only.
- **Configuration.**
  - Gertrude: `TEAMS_BOT_URL`, `TEAMS_BOT_SERVICE_TOKEN` (= `GERTRUDE_TO_BOT_TOKEN`) on the delivery
    worker; `TEAMS_BOT_VERIFY_TOKEN` (= `BOT_TO_GERTRUDE_TOKEN`; the name is kept so Terraform and
    secrets do not change) and `TEAMS_ALLOWED_TENANT_IDS` (comma separated) on the API. The worker also
    reads the new table, with the database access it already has.
  - Bot: `GERTRUDE_URL`, `GERTRUDE_VERIFY_TOKEN` (= `BOT_TO_GERTRUDE_TOKEN`), `SEND_SERVICE_TOKEN`
    (= `GERTRUDE_TO_BOT_TOKEN`), `SERVICE_URL_ALLOWED_HOSTS`, plus the Teams credentials. **No
    `DATABASE_URL`.**
- **Privacy of the stored row.** It holds a Teams tenant id, a Teams object id, a conversation id, a
  service URL and the reference JSON. No report text, no tokens. Treat it as personal data: no logging, no
  API route that returns it.
- **Versioning.** Paths carry `/v1/` on the bot side; the Gertrude routes sit under `/api/internal/teams/`.
  Additive response fields are allowed; consumers ignore unknown fields. Anything else is a new version.
