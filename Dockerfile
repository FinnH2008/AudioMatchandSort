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
    && pip install --no-cache-dir -r /app/requirements.txt \
    && (pip install --no-cache-dir "shazamio>=0.6.0" || echo "[TonArchiv] ShazamIO optional nicht verfuegbar — AcoustID/MusicBrainz bleiben aktiv")

# Essentia ist optional: Scheitert der Wheel-Install (z. B. ARM64), laeuft TonArchiv ohne Key/BPM/Spektral-Check weiter
RUN if [ "$INSTALL_ESSENTIA" = "true" ]; then \
      pip install --no-cache-dir essentia || echo "[TonArchiv] Essentia nicht verfuegbar — Key/BPM/Spektral-Check deaktiviert"; \
    fi

COPY backend/app.py /app/app.py
COPY backend/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
COPY --from=frontend-builder /ui/dist /app/static

EXPOSE 7070

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS --noproxy '*' http://127.0.0.1:7070/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
