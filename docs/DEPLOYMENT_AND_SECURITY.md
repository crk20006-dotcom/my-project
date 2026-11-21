# Project Genesis — Deployment, Security, Recovery & Troubleshooting Manual (Step 12)

## 1. Security Architecture & Safe Operation

### Local Authentication & Session Protection
- **Passcode Hashing**: Local operator passcodes are hashed with `PBKDF2-HMAC-SHA256` (100,000 iterations, random 16-byte salt) and compared in constant time via `crypto.timingSafeEqual`.
- **Rate Limiting**:
  - `/api/settings/verify-passcode`: Maximum 5 failed attempts per 60 seconds per client IP before `429 Too Many Requests` (`Retry-After`).
  - `/api/*` global guard: 600 requests/minute per client IP.
  - `/api/research/world/*`: 20 outbound retrievals/minute per client IP.
- **Session Storage & CSRF**:
  - Session tokens are generated with 256-bit `crypto.randomBytes(32)` and stored hashed (`SHA-256`) in SQLite `sessions` with an 8-hour TTL.
  - Browser clients hold Bearer tokens strictly in JS memory (`inMemorySessionToken`) paired with server-issued `HttpOnly` session cookies (`SameSite=Lax` over localhost HTTP, `SameSite=None; Secure; Partitioned` over HTTPS). Never stored in `localStorage` or `sessionStorage`.
  - State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) verify same-origin headers (`Origin` vs `Host` / `X-Forwarded-Host`) to mitigate cross-site request forgery.
- **HTTP Security Headers**:
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-DNS-Prefetch-Control: off`, `Cache-Control: no-store` on `/api/*`, and a scoped `Content-Security-Policy` blocking `object-src` and arbitrary outbound origins.

### SSRF & Sandbox Protections
- **Local Inference Endpoints**: `isLocalInferenceUrlSafe` restricts chat/STT/TTS/vision adapters exclusively to loopback hosts (`127.0.0.1`, `localhost`, `::1`).
- **World Intelligence Fetcher**: `validateExternalPublicUrl` restricts outbound HTTP retrieval strictly to `http://` and `https://` public hosts while blocking loopback (`127.0.0.0/8`, `::1`), private RFC1918 networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local / cloud metadata (`169.254.0.0/16`), embedded credentials, and unsafe redirects.
- **Code & Simulation Sandboxes**: Python/JS expression/simulation execution strips forbidden modules/globals (`os`, `subprocess`, `fs`, `child_process`, `fetch`, `eval`, etc.), runs with strict timeouts and memory limits, and requires explicit operator approval (`approved: true`).

---

## 2. Windows 10/11 Deployment (16 GB RAM CPU Target)

Project Genesis is designed to run cleanly on Windows systems with **16 GB RAM** and integrated graphics without requiring a discrete GPU or cloud AI subscriptions.

### Localhost vs LAN Exposure Policy
- **Default**: Bind to `127.0.0.1` (localhost-only) via `HOST=127.0.0.1` in `.env` or `.\scripts\start-windows.ps1`.
- **Explicit LAN Opt-In**: Only use `HOST=0.0.0.0` or `.\scripts\start-windows.ps1 -AllowLan` on a trusted private network **after enabling the Local Operator Passcode Lock** in **System Settings**.

### Quick Start (Windows PowerShell)
```powershell
# Development mode on http://127.0.0.1:3000
.\scripts\start-windows.ps1

# Production build + start on http://127.0.0.1:3000
.\scripts\start-windows.ps1 -Production

# Stop running server
.\scripts\stop-windows.ps1
```

### PWA Installation
- Chromium (Edge / Chrome on Windows & Android): Click **Install App** in the top bar or browser address bar to install Project Genesis as a standalone desktop/mobile PWA.
- iOS Safari: Tap **Install App** for guided **Share -> Add to Home Screen** steps.
- Offline behavior: UI shell & static assets are precached by Workbox. Data APIs (`/api/*`) stay `NetworkOnly` so SQLite state is never stale-cached.

---

## 3. Database Backup, Integrity & Recovery Procedures

### Routine Backups (System Settings -> Service Health, Reliability & Database Recovery)
1. **Binary SQLite Snapshot (`Download Binary .db`)**: Executes `PRAGMA wal_checkpoint(TRUNCATE)` followed by `VACUUM INTO` to create a clean, single-file crash-safe `.db` snapshot.
2. **Full JSON Workspace Snapshot (`Export JSON Backup`)**: Exports all workspace tables cleanly (passcode hashes/salts are always excluded from exports).
3. **Atomic JSON Restore (`Restore JSON Backup`)**: Validates the uploaded JSON structure and restores all workspace tables inside an atomic `BEGIN IMMEDIATE ... COMMIT` SQLite transaction while re-syncing FTS5 search indexes.

### Integrity Verification & Safe Migrations
- Run **Run SQLite Integrity Check** in **System Settings** (or `POST /api/system/integrity-check`) to verify `PRAGMA integrity_check(10) = ok`, `PRAGMA foreign_key_check` (`0` violations), WAL mode, FTS5 status, and applied entries in `schema_migrations`.

---

## 4. Local Genesis Core Training (Independent Transformer)

1. Activate Python environment in `backend/`:
   ```powershell
   cd backend
   .\.venv\Scripts\Activate.ps1
   ```
2. Train a CPU-friendly preset (`cpu_nano` ~0.1M params, `cpu_micro` ~1M params, `cpu_small` ~6M params — all safe under 16 GB host RAM):
   ```powershell
   python scripts/train_genesis_core.py --corpus ../docs --preset cpu_nano --steps 100
   ```
3. Inspect checkpoint and tokenizer status inside **Genesis Model Manager**.

---

## 5. Troubleshooting Guide

| Symptom | Cause | Resolution |
| --- | --- | --- |
| `401 AUTH_REQUIRED` | Session lock active or expired 8h cookie | Enter passcode on Lock Screen |
| `429 Too many failed attempts` | >5 wrong passcode tries in 60s | Wait for `Retry-After` cooldown timer |
| World Intelligence `network_unavailable` | Host offline or upstream blocked | Check connectivity; verify public URL (private/loopback URLs are blocked by SSRF guard) |
| Local inference fallback (`demo_mode`) | No local LLM server running at loopback URL | Start `llama.cpp` / Ollama / local server on `127.0.0.1:8080` and click **Probe** in Model Manager |
| OCR / Audio limitation | Optional `ffmpeg` or Whisper server absent | Audio metadata extraction still works; set loopback Whisper/Piper URLs in Settings for full transcription |
