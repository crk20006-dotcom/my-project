# Security Summary

Project Genesis enforces a local-first, defense-in-depth security posture across its browser workstation, Express API layer, SQLite database, and local tool/world connectors without requiring external paid APIs or cloud accounts.

## Security Controls Implemented & Verified

- **Authentication & Session Hygiene** (`server/routes/api.ts`, `src/services/apiClient.ts`)
  - Local operator passcodes are salted (16-byte random salt) and hashed using `PBKDF2-HMAC-SHA256` (100,000 iterations), verified with constant-time comparison (`crypto.timingSafeEqual`).
  - Active sessions issue 256-bit cryptographically random tokens stored as `SHA-256` hashes in SQLite (`sessions`) with an 8-hour TTL and explicit server-side revocation on logout or passcode change.
  - Browser clients retain Bearer tokens strictly in JS memory (`inMemorySessionToken`) alongside server-issued `HttpOnly` session cookies (`SameSite=Lax` over localhost HTTP; `SameSite=None; Secure; Partitioned` over HTTPS previews). No session secrets or credentials are written to `localStorage` or `sessionStorage`.
- **Rate Limiting & Brute-Force Protection** (`server/routes/api.ts`, `server/research/worldIntelligence.ts`)
  - `/api/settings/verify-passcode` enforces a 5-failure/minute lockout per client IP (`429 Too Many Requests` with `Retry-After`).
  - `/api/*` enforces a global 600 requests/minute rate limit per client IP.
  - `/api/research/world/*` enforces a 20 requests/minute outbound connector limit per client IP.
- **Cross-Origin Mutation & HTTP Header Hardening** (`server.ts`, `server/routes/api.ts`)
  - Express disables `X-Powered-By`, sets `Cache-Control: no-store` on all `/api/*` routes, sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-DNS-Prefetch-Control: off`, `Permissions-Policy`, and a scoped `Content-Security-Policy` blocking plugins (`object-src 'none'`) and arbitrary outbound network origins.
  - State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) with an `Origin` header validate that `Origin` host matches `Host` / `X-Forwarded-Host` (`403 CSRF_ORIGIN_MISMATCH` otherwise).
- **SSRF Protection & Sandboxing** (`server/ai/interfaces.ts`, `server/research/worldIntelligence.ts`, `server/creator/fileSafety.ts`)
  - Local inference, STT, TTS, and Vision HTTP adapters accept only loopback hosts (`127.0.0.1`, `localhost`, `::1`).
  - World Intelligence public web/RSS retrieval (`validateExternalPublicUrl`) permits only public `http://`/`https://` hosts and rejects loopback (`127.0.0.0/8`, `::1`), RFC1918 private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local/cloud metadata (`169.254.0.0/16`), embedded URL credentials, internal TLDs, and unsafe redirect hops.
  - Creator Studio and Multimodal uploads validate magic bytes (strictly accepting `.png`, `.jpg`, `.jpeg`, `.webp`, `.docx`, `.pptx`, `.pdf`, `.wav`, and safe source extensions) and block path traversal or system/database filenames.
- **Secret Redaction in Logging & Exports** (`server/system/logger.ts`, `server/db.ts`)
  - Structured JSONL logs in `./data/logs/genesis-server.log` (2 MB rotation cap) automatically mask Bearer tokens, API key patterns, and JSON/header credential fields (`passcode`, `password`, `token`, `secret`, `cookie`) with `[REDACTED]`. JSON DB exports omit `passcode_hash` and `passcode_salt`.
- **Dependency Audit Note** (`bun audit`)
  - Dependency scanning flagged two transitive advisories in `pptxgenjs > image-size@1.2.1` (JXL/HEIF/ICNS infinite-loop parsers) and two build-tool advisories in `vite-plugin-pwa > workbox-build > glob` (`minimatch`). In Project Genesis, presentation and Creator image upload handlers strictly enforce PNG/JPEG magic bytes (`verifyImageMagicBytes`), preventing JXL, HEIF, or ICNS binaries from reaching `image-size`.

---

## PoC Verification

All verification checks below were executed cleanly against the final codebase:

1. **Automated Full-Stack API, Security, Reliability & Domain Test Suite (`npm run test:server`)**
   - Result: **30/30 tests passing across 6 suites** (`fail: 0`, `duration: ~20.4s`), covering:
     - Unauthenticated `401` enforcement across core, Creator Studio, Multimodal, Engineering, World Intelligence, Backup/Restore, and Integrity routes.
     - Cross-origin mutation rejection (`403 CSRF_ORIGIN_MISMATCH`) when sending an untrusted `Origin` header.
     - Rate-limit lockout (`429 + Retry-After`) after 5 wrong passcode attempts, session revocation on `/api/auth/logout`, and expired session rejection.
     - `POST /api/system/integrity-check` confirming SQLite `PRAGMA integrity_check = ["ok"]`, `0` foreign key violations, WAL journal mode, and 4 applied `schema_migrations` records.
     - `GET /api/settings/export-sqlite` producing valid `SQLite format 3` binary `.db` snapshots and `POST /api/settings/restore-db` atomically restoring deleted records while rejecting malformed JSON backups with `400`.
     - Structured logger secret redaction verifying private passcodes and tokens are replaced with `[REDACTED]`.
     - World Intelligence SSRF rejection (`400`) on `http://169.254.169.254/latest/meta-data/`, loopback, private RFC1918, and `file://` URLs, plus fixture verification of Wikipedia/arXiv/RSS/HTML timestamps and clean offline error reporting.
     - Latency check confirming `< 500ms` responses across `/api/health`, `/api/engineering/calculate`, `/api/retrieval/query`, and `/api/settings/export-db`.
2. **Type-Check, Build & Native Node Execution**
   - `tsc --noEmit`: Passed with 0 errors.
   - `vite build` & PWA verification: Built clean `/dist` output containing `manifest.webmanifest`, `sw.js`, `registerSW.js`, and real PNG icons (`pwa-192x192.png`, `pwa-512x512.png`, `pwa-maskable-512x512.png`, `apple-touch-icon.png`).
   - Native Node 22 runtime (`node -e "import('./server/routes/api.ts')..."`): Passed (`NODE_TS_OK`), confirming `npm start` (`node server.ts`) executes cleanly without `tsx`.
3. **Static Security Scan**
   - Recursive scan across `src/` and `server/` confirmed zero usage of `localStorage`, `sessionStorage`, `dangerouslySetInnerHTML`, `.innerHTML =`, `eval(`, or `new Function(`.
