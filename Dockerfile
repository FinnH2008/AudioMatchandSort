# =============================================================================
# TonArchiv — Multi-Stage Single-Container Dockerfile (Port 7070)
# Direkt aus GitHub baubar: docker compose up -d --build
# =============================================================================

# Stage 1: Statisches React-Dashboard bauen
FROM node:22-slim AS frontend-builder
WORKDIR /ui

COPY package.json package-lock.json* .npmrc* ./
RUN if [ -f package-lock.json ]; then npm ci --legacy-peer-deps; else npm install --legacy-peer-deps; fi

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

# Stage 2: Single-Container FastAPI + Audio-Engine (keine Node-Zwischenschicht im Betrieb)
FROM python:3.11-slim-bookworm

ARG INSTALL_ESSENTIA=false
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TONARCHIV_PORT=7070

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libchromaprint-tools \
    libchromaprint1 \
    libsndfile1 \
    gosu \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /app/requirements.txt

# Essentia ist optional: Scheitert der Wheel-Install (z. B. ARM64), laeuft TonArchiv ohne Key/BPM/Spektral-Check weiter
RUN if [ "$INSTALL_ESSENTIA" = "true" ]; then \
      pip install --no-cache-dir essentia || echo "[TonArchiv] Essentia nicht verfuegbar — Key/BPM/Spektral-Check deaktiviert"; \
    fi

COPY backend/app.py /app/app.py
COPY --from=frontend-builder /ui/dist /app/static

EXPOSE 7070

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:7070/api/health || exit 1

# Startet als konfigurierte PUID/PGID (mit Fallback, falls NAS-Mount chown blockiert)
ENTRYPOINT ["/bin/sh", "-c", "CFG=\"${CONFIG_DIR:-/config}\"; UID_NUM=\"${PUID:-1000}\"; GID_NUM=\"${PGID:-1000}\"; mkdir -p \"$CFG\" 2>/dev/null || true; chown -R \"$UID_NUM:$GID_NUM\" \"$CFG\" 2>/dev/null || true; echo \"[TonArchiv] Starte FastAPI auf Port 7070 (CONFIG=$CFG, UID=$UID_NUM:$GID_NUM)\"; if gosu \"$UID_NUM:$GID_NUM\" test -w \"$CFG\" 2>/dev/null; then exec gosu \"$UID_NUM:$GID_NUM\" uvicorn app:app --app-dir /app --host 0.0.0.0 --port 7070 --proxy-headers --log-level info; else echo \"[TonArchiv] Warnung: $CFG fuer $UID_NUM:$GID_NUM nicht beschreibbar — starte ohne UID-Wechsel\"; exec uvicorn app:app --app-dir /app --host 0.0.0.0 --port 7070 --proxy-headers --log-level info; fi"]
