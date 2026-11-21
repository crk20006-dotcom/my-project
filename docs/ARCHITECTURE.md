# Project Genesis — System Architecture (Steps 01–12)

## 1. Architectural Overview

Project Genesis separates presentation, orchestration, domain computation, local SQLite persistence, and neural inference adapters into cleanly decoupled layers so foundation models, retrieval providers, and multimodal engines can be swapped independently without rewriting UI workspaces or database schemas.

```text
+-----------------------------------------------------------------------------+
|  Frontend Workstation (React + TypeScript + Tailwind CSS + PWA)             |
|  Chat, Memory, Agents, Research, Creator, Multimodal, Engineering, Models   |
|  JS Memory Session State + HttpOnly Auth Cookies + Offline Status Indicator |
+-----------------------------------------------------------------------------+
                                      |
               Same-Origin REST / JSON / Binary Downloads (/api/*)
                                      |
+-----------------------------------------------------------------------------+
|  Hardened Express Security & API Layer (/server.ts, /server/routes/api.ts)  |
|  - Security Headers & CSP · Origin CSRF Guard · Global & Auth Rate Limits   |
|  - HttpOnly Cookie + Bearer Session Auth (PBKDF2-SHA256) · Redacted Logging |
+-----------------------------------------------------------------------------+
      |                             |                               |
+---------------------------+ +---------------------------+ +--------------------+
|  Local SQLite Persistence | | Intelligence & Model Core | |  Domain Workspaces |
|  ./data/genesis.db (WAL)  | | - GenesisCoreAdapter      | | - Agent OS & Tools |
|  - schema_migrations      | | - LocalHttpInference      | | - World Intel SSRF |
|  - conversations/messages | | - Safetensors/GGUF Inspect| | - Creator Studio   |
|  - memory_entries + FTS5  | | - Tokenizer & RAG Retrieve| | - Multimodal OCR   |
|  - knowledge + FTS5       | +---------------------------+ | - Engineering + Sci|
|  - research & experiments |                               +--------------------+
|  - engineering & creator  |
|  - sessions & system      |
+---------------------------+
```

## 2. Independent Intelligence & Model Architecture

Located in `/server/ai/`, `/server/research/`, `/server/multimodal/`, and `/src/types/genesis.ts`:

1. **Model & Inference Adapters (`BaseModelAdapter`, `BaseInferenceEngine`)**: Supports `GenesisCoreAdapter` (checkpoint & tokenizer inspection on disk) and `LocalHttpInferenceAdapter` (restricted strictly to loopback `127.0.0.1` / `localhost` / `::1` endpoints such as `llama.cpp`, `Ollama`, or local OpenAI-compatible runtimes). No paid cloud AI APIs are required.
2. **Tokenizer & Retrieval (`BaselineTokenizer`, `SqliteKeywordRetriever`)**: Deterministic byte/token accounting alongside local SQLite FTS5 + keyword retrieval for approved user memory and ingested knowledge chunks.
3. **Agent Operating System (`/server/agent/`)**: Step-budgeted deterministic task planner, explicit operator approval gate for consequential tools (`create_document`, `run_restricted_code`), sandboxed workspace path containment, and execution history.
4. **World Intelligence (`/server/research/worldIntelligence.ts`)**: Opt-in public search adapters (`WikipediaSearchAdapter`, `ArxivSearchAdapter`) and RSS/Atom/HTML parser with strict DNS/IP SSRF blocking (private, loopback, link-local, and metadata CIDR ranges rejected), publication date attribution, and rate limiting.
5. **Creator, Multimodal & Engineering Engines**: Real server-side document/deck generation (`docx`, `pdf`, `pptx`, `md`), local image/audio/OCR adapters (Tesseract/Whisper when installed locally), and unit-checked scientific & engineering solvers with optional local Python SymPy/NumPy verification.

## 3. Security, Reliability & Performance Architecture

- **Authentication & Sessions**: Optional operator passcode protection uses `PBKDF2-HMAC-SHA256` (100,000 iterations, random 16-byte salt) and constant-time comparison. Sessions are issued via `HttpOnly` cookies (with `SameSite=None; Secure; Partitioned` over TLS and `SameSite=Lax` over localhost HTTP) and JS-memory Bearer tokens (never written to `localStorage` or `sessionStorage`).
- **Transport & Mutation Protection**: Helmet-equivalent response headers, scoped Content-Security-Policy, `Cache-Control: no-store` on `/api/*`, same-origin `Origin`/`Host` mutation check, brute-force passcode lockouts (`429 + Retry-After`), and global API + World Intelligence rate limiters.
- **Database Integrity & Recovery**: WAL mode, schema migration registry (`schema_migrations`), indexed foreign/timestamp lookups, `PRAGMA integrity_check` + `PRAGMA foreign_key_check`, hot binary `.db` snapshot export via `VACUUM INTO`, and validated atomic JSON restore.
- **Structured Logging**: Redacted JSONL log files in `./data/logs/genesis-server.log` (capped rotation at 2 MB) paired with an in-memory 250-entry diagnostics ring buffer.
- **16 GB RAM CPU-First Sizing**: Targets Windows 10/11 desktops without discrete GPUs (150–400 MB base Node/SQLite footprint, leaving headroom for 4-bit quantized 7B–8B local models).
