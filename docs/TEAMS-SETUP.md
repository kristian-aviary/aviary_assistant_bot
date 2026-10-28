# Teams setup (Azure and Teams steps for humans)

None of this has been run by the build. Every command below is taken from `teams --help` of
`@microsoft/teams.cli` 3.0.4 (read, not executed: it needs a Microsoft 365 login) and from the Teams manifest
schema. Treat output formats and prompts as unconfirmed.

Each step is marked **required** or **optional** for the pilot.

## What is not known (read this first)

**Whether a Teams-managed, single-tenant bot can message users in a customer's own Microsoft 365 tenant has not
been verified.** Everything here works for users in the tenant that owns the bot registration. For a customer
tenant three things are unknown, and any of them can fail:

1. Whether Teams delivers `installationUpdate` / `message` activities from the customer tenant to a bot that is
   registered single-tenant in ours, and whether the SDK's inbound validation accepts them.
2. Whether the bot's token (acquired in our tenant) is accepted by the connector when sending to a conversation
   in the customer's tenant.
3. Whether the roster call returns the user's email there.

### The smallest spike that settles it

Needs a second Microsoft 365 tenant that is **not** the one that owns the bot (a Microsoft 365 developer or trial
tenant, with one test user who has a mailbox and Teams, and an admin who can upload custom apps).

1. Register the bot in tenant A (steps 1 to 4 below) with `--teams-managed` and a single-tenant audience, and run
   the service locally with a tunnel (step 5).
2. Package the app (step 6) and upload it in tenant B's Teams admin center (Manage apps, Upload new app); make it
   available to the B test user; install it for that user, personal scope.
3. Observe, in this order, and write each result down:
   - Does the service receive `installationUpdate add` (a `reference_stored` or `inbound_refused` log line, or a
     `sdk_log` warn if token validation failed)?
   - Did the roster email come back (no `EMAIL_UNAVAILABLE`), and did the fake or real Gertrude get the
     tenant B id?
   - With the user **not** having written anything, `POST /v1/send` with a card to that user: does it answer `200`
     and does the card appear? Then close Teams for the user and send again.
4. If any observation fails, repeat steps 1 to 3 with the registration recreated as multi-tenant
   (`--sign-in-audience multipleOrgs`), and then with Azure Bot Service (step 9). The first variant that passes all
   three is the pilot configuration. Record which one.

Pass condition: all three observations succeed for the tenant-B user. Until this passes, do not promise Teams
delivery to any customer.

## Steps

### 1. Prerequisites (required)

- A Microsoft 365 tenant with Teams, where you can sideload a custom app (Teams admin center, Teams apps,
  Setup policies / Permission policies: "Upload custom apps" on), and a test user with a mailbox.
- Node 22, `npm i -g @microsoft/teams.cli` (command `teams`), and the Dev Tunnels CLI (`devtunnel`) for local runs.
- This repo checked out, `npm ci`.

### 2. Log in with the Teams CLI (required)

```bash
teams login --device-code
```

### 3. Register the bot (required)

Teams-managed registration, no Azure subscription:

```bash
teams app create --name "Aviary Assistant" --endpoint https://<public-host>/api/messages --env .env.bot --json
```

`--teams-managed` is the default. `--sign-in-audience myOrg|multipleOrgs` chooses single- or multi-tenant (see the
spike; the choice matters for customers). `--no-secret` skips the client secret (only for managed identity).

Take `CLIENT_ID`, `CLIENT_SECRET` and `TENANT_ID` from the credentials file and put them in the service's
environment (Railway variables, or a local `.env`). **Check the variable names the CLI wrote** against
`.env.example`; the service wants exactly `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`. Never commit them, and never
reuse Crow's registration or secret (contract T8: separate Teams app registration).

Check it: `teams app doctor <appId>` and `teams app bot get <appId>`.

### 4. Messaging endpoint (required)

The endpoint is `https://<host>/api/messages`. Set or change it with:

```bash
teams app update <appId> --endpoint https://<host>/api/messages
```

For Railway, `<host>` is the service's domain (see [RAILWAY.md](RAILWAY.md)); redo this whenever it changes.

### 5. Local run with a tunnel (optional for the pilot, required for any local Teams test)

```bash
devtunnel user login
devtunnel create aviary-bot --allow-anonymous
devtunnel port create aviary-bot -p 3978
devtunnel host aviary-bot            # prints https://<id>-3978.<region>.devtunnels.ms
teams app update <appId> --endpoint https://<id>-3978.<region>.devtunnels.ms/api/messages
```

Anonymous access is needed because Microsoft's Bot Framework service calls the endpoint without a dev-tunnel
login; the bot still validates every inbound token itself. Then run the service with real env vars against a
local Postgres, and a fake Gertrude if the real one is not reachable (`npm run fake:gertrude`, see its header
for its fixed bearer; set `FAKE_GERTRUDE_USERS='<email>=<user_id>,...'` to the test user's roster email; the bot's
`GERTRUDE_VERIFY_TOKEN` must equal that bearer).

### 6. Build the app package (required)

```bash
CLIENT_ID=<bot app id> npm run package:app
```

Output: `appPackage/build/{manifest.json, color.png, outline.png, aviary-assistant.zip}`. Set
`APP_DEVELOPER_NAME`, `APP_WEBSITE_URL`, `APP_PRIVACY_URL`, `APP_TERMS_URL` to real values before anyone outside
the team installs it (**required** before customers; the defaults are placeholders). The icons are generated
placeholders; replace `scripts/lib/png.ts` output with the design team's PNGs (192x192 color, 32x32 outline) when
they exist (**optional** for an internal pilot).

The manifest id is a fresh UUID of ours (`43d89c2d-145f-480a-bea7-39566082fb4e`). `teams app create` may assign its
own app id and may insist that an uploaded manifest carries that id. If so, rebuild with `APP_ID=<id the CLI
reported>`. Unconfirmed; the build never ran the CLI.

### 7. Install it (required)

Either:

- Teams client, Apps, Manage your apps, Upload an app, Upload a custom app, choose the zip (needs the sideloading
  policy), then Add; or
- Teams admin center, Manage apps, Upload new app, then allow it for the users through the app permission and
  setup policies; the user then installs it from Built for your org.

Or for an app already registered with the CLI: `teams app manifest upload appPackage/build/manifest.json <appId>`.

Installing in personal scope is what produces the `installationUpdate add` activity that links the user. The user
sees "You will receive Aviary Assistant reports here." once linked, or the not-set-up message if Gertrude does not
know their email.

### 8. Tenant admin consent

- **Permissions consent: none needed.** The manifest requests no resource-specific consent, no `webApplicationInfo`,
  no Graph application permissions. (**required** to confirm in the pilot tenant: that no consent prompt appears.)
- **Admin approval of the app: required in any tenant whose policy blocks custom apps**, which is most customer
  tenants: their Teams admin must allow the uploaded app and make it available to the users who should get reports.
- **Roster email**: read through the Bot Framework roster call, which in the documentation does not need Graph
  consent. Not verified here (see the spike).

### 9. Azure Bot Service instead of the Teams-managed bot (optional; use if the spike says the CLI route cannot serve customer tenants)

```bash
teams app create --name "Aviary Assistant" --azure --resource-group <rg> --subscription <id> --endpoint https://<host>/api/messages
```

needs the `az` CLI, an Azure subscription and a resource group, and `--sign-in-audience`. The service code does not
change; only where the registration lives and who pays. `teams app bot migrate` moves a Teams-managed bot to Azure
later.

### 10. Pin or pre-install for users (optional)

A Teams setup policy can pre-install and pin the app for users. Out of scope for v0 beyond mentioning it:
this service does not onboard people who have not installed the bot, and `POST /v1/send` answers `404 no_reference`
for them.

## What changes for a recipient in a customer's tenant

| Item | Our own tenant | Customer tenant |
|---|---|---|
| Getting the app | sideload or our admin center | the customer's Teams admin uploads our package (or we publish through a store; out of scope), allows it and assigns it. Their policy can block it. |
| Bot registration | ours | the same registration; it must accept their tenant (single- vs multi-tenant) , **unverified** |
| Who may link | Gertrude's `TEAMS_ALLOWED_TENANT_IDS` | add the customer tenant id there too, otherwise Gertrude answers `404` and the user is told they are not set up |
| Email | roster | roster email must equal the Aviary user's email (lower-cased, exact) |
| Privacy and terms | placeholders | the privacy and terms URLs in the manifest are shown to the customer admin: must be real |
| Service URL | `smba.trafficmanager.net` | a customer on a sovereign cloud or a different region host needs it in `SERVICE_URL_ALLOWED_HOSTS` |
