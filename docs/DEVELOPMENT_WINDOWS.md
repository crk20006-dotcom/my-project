# Windows Local Development & Deployment Guide — Project Genesis

This guide covers installing, running, updating, and operating **Project Genesis** on **Windows 10 / Windows 11** systems with **16 GB RAM** and integrated graphics (CPU-first runtime, zero paid AI APIs required).

---

## 1. Prerequisites

- **Node.js 22.12+ LTS** (`node -v`) and **npm** (`npm -v`)
- Optional local inference engines (loopback only, e.g., `http://127.0.0.1:8080` or `http://127.0.0.1:11434`): `llama.cpp` server or Ollama
- Optional local multimodal/scientific tools on `PATH`: `python` (with `sympy`/`numpy`), `tesseract`, `whisper`

---

## 2. Quick Start (PowerShell)

Open PowerShell in the Project Genesis root folder:

```powershell
# Install dependencies (first time or after pulling updates)
npm install

# Start Project Genesis in production mode on http://127.0.0.1:3000 (auto-builds dist/ if missing)
.\scripts\start-windows.ps1
```

Optional start flags:

```powershell
# Force clean production bundle rebuild before starting
.\scripts\start-windows.ps1 -Rebuild

# Development server with live middleware
.\scripts\start-windows.ps1 -Mode dev

# Explicitly opt in to LAN access (enable Passcode Lock first!)
.\scripts\start-windows.ps1 -AllowLan
```

To gracefully stop the background server process:

```powershell
.\scripts\stop-windows.ps1
```

---

## 3. Manual Commands & Environment

If you prefer running manually without the PowerShell helpers:

```powershell
copy .env.example .env
npm run build
npm start
```

Default environment settings bind strictly to loopback:

```env
HOST=127.0.0.1
PORT=3000
NODE_ENV=production
GENESIS_DB_PATH=./data/genesis.db
```

Open `http://127.0.0.1:3000` in Microsoft Edge or Google Chrome. Click **Install App** in the top navigation bar (or browser address bar) to install Project Genesis as a standalone desktop **PWA**.

---

## 4. Verification & Maintenance

```powershell
# Type-check & lint
npm run lint

# Run backend API, security, reliability & domain test suite
npm run test:server

# Build frontend PWA bundle
npm run build
```

For full security hardening, backup/restore procedures, 16 GB RAM sizing, and LAN firewall precautions, see `docs/DEPLOYMENT_AND_SECURITY.md`.
