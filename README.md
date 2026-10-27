# Aviary Assistant Bot

Microsoft Teams bot that delivers Aviary Assistant hypercare reports to people in Teams.

It is deliberately small: it owns the Microsoft-facing parts (the Teams app, the inbound endpoint, stored
conversation references) and nothing else. Gertrude decides who a Teams user is and what to send; this
service delivers it. No LLM, no data access.

- Contract with Gertrude: [docs/CONTRACT.md](docs/CONTRACT.md)
- Build spec for v0: [docs/specs/agent-6-teams-bot-service.md](docs/specs/agent-6-teams-bot-service.md)
- Hosted on Railway.

Status: scaffolding only. Implementation lands on `feat/bot-v0`.
