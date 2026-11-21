# Project Genesis — REST API Reference

Base prefix: `/api` (all responses set `Cache-Control: no-store`; private routes require valid session cookie or Bearer token when `local_auth_enabled` is active).

## Health, Authentication & Diagnostics

- `GET /api/health` — Public health telemetry (SQLite check, WAL mode, RSS/heap memory MB, uptime, host binding, LAN exposure flag, error/security event counts).
- `GET /api/auth/status` — Returns `{ local_auth_enabled, authenticated, first_run_completed }`.
- `POST /api/auth/logout` — Revokes active session token and clears `HttpOnly` session cookie.
- `GET /api/genesis-core/status` — Genesis Core checkpoint validation, tokenizer vocabulary metrics, 16 GB RAM budget guide, and operational vs. experimental capability inventory.

## Conversations & Chat

- `GET /api/conversations` · `POST /api/conversations` · `PATCH /api/conversations/:id` · `DELETE /api/conversations/:id`
- `GET /api/conversations/search?q=` — Search stored conversation messages.
- `GET /api/conversations/:id/messages` · `POST /api/conversations/:id/messages` — Persist user prompts and dispatch to the active local adapter (`GenesisCore` or `LocalHttpInferenceAdapter`).
- `POST /api/upload/validate` — Validate attachment filename, extension allowlist, and size cap.

## Models, Memory & Knowledge Base

- `GET /api/models` · `POST /api/models` · `PUT /api/models/:id` · `POST /api/models/:id/probe` · `DELETE /api/models/:id`
- `GET /api/memory` · `GET /api/memory/status` · `POST /api/memory` · `PATCH /api/memory/:id` · `DELETE /api/memory/:id`
- `GET /api/knowledge` · `POST /api/knowledge` · `POST /api/knowledge/upload` · `DELETE /api/knowledge/:id`
- `POST /api/retrieval/query` — Unified SQLite FTS5 + keyword retrieval across approved memories and ingested documents.

## Agent OS & Laboratory

- `GET /api/agent-tools` · `GET /api/agents` · `POST /api/agents` · `DELETE /api/agents/:id`
- `GET /api/agent-tasks` · `POST /api/agent-tasks` · `POST /api/agent-tasks/:id/run` · `POST /api/agent-tasks/:id/approve` · `POST /api/agent-tasks/:id/cancel`
- `GET /api/agent-history` · `GET /api/laboratory` · `POST /api/laboratory` · `POST /api/laboratory/tokenize` · `DELETE /api/laboratory/:id`

## Research, Experiments & World Intelligence

- `GET /api/research` · `POST /api/research` · `PUT /api/research/:id` · `DELETE /api/research/:id`
- `GET /api/experiments` · `POST /api/experiments` · `PUT /api/experiments/:id` · `DELETE /api/experiments/:id`
- `GET /api/research/world/providers` — List available public World Intelligence providers and rate-limit policy.
- `POST /api/research/world/search` — Query Wikipedia or arXiv APIs (20 req/min limit) with attribution, publication dates, and retrieval timestamps.
- `POST /api/research/world/fetch-url` — Fetch a public `http://`/`https://` RSS/Atom feed or webpage (SSRF-guarded against loopback/private/link-local/metadata IPs).

## Creator Studio, Multimodal & Engineering

- `GET /api/creator/projects` · `POST /api/creator/projects` · `GET /api/creator/projects/:id/files` · `POST /api/creator/files/save` · `POST /api/creator/files/upload` · `POST /api/creator/documents/export` · `POST /api/creator/presentations/export` · `POST /api/creator/code/analyze` · `POST /api/creator/code/sandbox`
- `GET /api/multimodal/capabilities` · `POST /api/multimodal/analyze-image` · `POST /api/multimodal/process-document` · `POST /api/multimodal/transcribe-audio`
- `GET /api/engineering/status` · `GET /api/engineering/disciplines` · `POST /api/engineering/disciplines/explain` · `POST /api/engineering/calculate` · `POST /api/engineering/math` · `POST /api/engineering/units/convert` · `POST /api/engineering/diagram/export` · `POST /api/engineering/export-report` · `POST /api/engineering/integrate/*`

## System Settings, Backup & Reliability

- `GET /api/settings` · `PUT /api/settings` · `POST /api/settings/verify-passcode`
- `PUT /api/settings/first-run` — Complete initial onboarding (`operator_name`, optional passcode enablement).
- `GET /api/settings/export-db` — Download validated JSON workspace backup snapshot.
- `GET /api/settings/export-sqlite` — Download hot binary `.db` SQLite snapshot created via `VACUUM INTO`.
- `POST /api/settings/restore-db` — Validate and atomically restore a Genesis JSON backup snapshot.
- `POST /api/settings/reset` — Reset workspace tables to starter defaults.
- `POST /api/system/integrity-check` — Execute `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, and list applied `schema_migrations`.
- `GET /api/system/logs` — Inspect recent redacted server/security events.
