import { PipelineConfig } from '../types/tonarchiv';

export interface GeneratedDockerFile {
  filename: string;
  language: 'yaml' | 'dockerfile' | 'python' | 'text' | 'markdown' | 'dotenv';
  description: string;
  content: string;
}

export function generateDockerBundle(config: PipelineConfig): GeneratedDockerFile[] {
  const djLayoutEnv = config.djRemixLayout === 'root_folder' ? 'root_folder' : 'split_by_quality';

  const dockerCompose = `services:
  tonarchiv:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        INSTALL_ESSENTIA: "${config.enableEssentia ? 'true' : 'false'}"
    image: tonarchiv:latest
    container_name: tonarchiv
    restart: unless-stopped
    ports:
      - "\${TONARCHIV_PORT:-7070}:7070"
    env_file:
      - .env
    environment:
      PUID: "\${PUID:-${config.puid}}"
      PGID: "\${PGID:-${config.pgid}}"
      MUSIC_DIR: "${config.containerMusicDir}"
      CONFIG_DIR: "${config.configDir}"
      CONFIDENCE_THRESHOLD: "${config.confidenceThreshold.toFixed(2)}"
      MIN_LOSSY_BITRATE: "${config.minLossyBitrateKbps}"
      SEPARATE_LOW_QUALITY_LOSSY: "${config.separateLowQualityLossy ? 'true' : 'false'}"
      MIXED_ALBUM_STRATEGY: "${config.mixedAlbumStrategy}"
      DJ_REMIX_LAYOUT: "${djLayoutEnv}"
      ENRICH_REMIX_EMPTY_FIELDS: "${config.enrichRemixEmptyFields ? 'true' : 'false'}"
      KEEP_REVIEW_IN_PLACE: "${config.keepReviewTracksInPlace ? 'true' : 'false'}"
      ENABLE_SHAZAMIO: "${config.enableShazamFallback ? 'true' : 'false'}"
      ENABLE_ESSENTIA: "${config.enableEssentia ? 'true' : 'false'}"
      WAV_EMBED_MEDIA: "${config.wavEmbedMedia ? 'true' : 'false'}"
      KEY_FORMAT: "${config.keyFormat}"
      COVER_MAX_SIZE: "${config.coverMaxSize}"
      SAVE_FOLDER_COVER_JPG: "${config.saveFolderCoverJpg ? 'true' : 'false'}"
      FETCH_LYRICS: "${config.fetchLyrics ? 'true' : 'false'}"
      WRITE_LRC_SIDECAR: "${config.writeLrcSidecar ? 'true' : 'false'}"
      WRITE_REPLAYGAIN: "${config.writeReplayGain ? 'true' : 'false'}"
      SMB_CASE_SAFE: "${config.smbCaseSafe ? 'true' : 'false'}"
      MAX_PATH_LENGTH: "${config.maxPathLength}"
      CLEANUP_EMPTY_DIRS: "${config.cleanupEmptyDirs ? 'true' : 'false'}"
    volumes:
      # WICHTIG: Genau ein einzelner Mount fuer atomares Verschieben im selben Dateisystem
      - "\${HOST_MUSIC_DIR:-${config.hostMusicDir}}:${config.containerMusicDir}"
      # Persistente SQLite-Cache-DB (cache.db) und atomares Journal (rollback.json)
      - "\${HOST_CONFIG_DIR:-./config}:${config.configDir}"
`;

  const dockerfile = `# Stage 1: Statisches React-Frontend bauen (direkt aus GitHub-Repo baubar)
FROM node:22-slim AS frontend-builder
WORKDIR /ui
COPY package.json ./
COPY package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

# Stage 2: Single-Container FastAPI + Audio-Engine (keine Node-Zwischenschicht im Betrieb)
FROM python:3.11-slim-bookworm

ARG INSTALL_ESSENTIA=${config.enableEssentia ? 'true' : 'false'}
ENV DEBIAN_FRONTEND=noninteractive \\
    PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    TONARCHIV_PORT=7070

RUN apt-get update && apt-get install -y --no-install-recommends \\
    ffmpeg \\
    libchromaprint-tools \\
    libchromaprint1 \\
    libsndfile1 \\
    gosu \\
    curl \\
    ca-certificates \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \\
    && pip install --no-cache-dir -r /app/requirements.txt

# Essentia ist optional: Scheitert der Wheel-Install (z. B. ARM64), laeuft TonArchiv ohne Key/BPM/Spektral-Check weiter
RUN if [ "$INSTALL_ESSENTIA" = "true" ]; then \\
      pip install --no-cache-dir essentia || echo "[TonArchiv] Essentia nicht verfuegbar — Key/BPM/Spektral-Check deaktiviert"; \\
    fi

COPY backend/app.py /app/app.py
COPY --from=frontend-builder /ui/dist /app/static

EXPOSE 7070

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD curl -fsS http://127.0.0.1:7070/api/health || exit 1

# Startet als konfigurierte PUID/PGID, damit NAS-Dateirechte (SMB/Unraid/Synology) erhalten bleiben
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p \\"\${CONFIG_DIR:-${config.configDir}}\\" && chown -R \\"\${PUID:-${config.puid}}:\${PGID:-${config.pgid}}\\" \\"\${CONFIG_DIR:-${config.configDir}}\\" && exec gosu \\"\${PUID:-${config.puid}}:\${PGID:-${config.pgid}}\\" uvicorn app:app --host 0.0.0.0 --port 7070"]
`;

  const requirementsTxt = `fastapi>=0.115.0
uvicorn[standard]>=0.32.0
pydantic>=2.9.0
mutagen>=1.47.0
musicbrainzngs>=0.7.1
pyacoustid>=1.3.0
python3-discogs-client>=2.7
syncedlyrics>=1.0.1
requests>=2.32.0
Pillow>=10.4.0
# Optionales Fallback (per ENABLE_SHAZAMIO=false abschaltbar):
shazamio>=0.7.0
`;

  const envExample = `# =============================================================================
# TonArchiv — Homeserver Docker Konfiguration (.env)
# Kopiere diese Datei nach .env und trage optionale API-Keys ein.
# Fehlende API-Keys deaktivieren nur die jeweilige Stufe (kein Absturz).
# =============================================================================

# Server-Port auf dem Homeserver
TONARCHIV_PORT=7070

# Benutzer- & Gruppen-ID auf dem Host (id -u / id -g auf Linux/NAS pruefen)
PUID=${config.puid}
PGID=${config.pgid}

# Verzeichnisse auf dem Host & im Container (genau EIN Mount fuer atomares Verschieben)
HOST_MUSIC_DIR=${config.hostMusicDir}
MUSIC_DIR=${config.containerMusicDir}
HOST_CONFIG_DIR=./config
CONFIG_DIR=${config.configDir}

# Externe API-Keys (optional — fehlende Keys deaktivieren nur die jeweilige Stufe)
# AcoustID (kostenlos): https://acoustid.org/new-application
ACOUSTID_API_KEY=
# Discogs Personal Access Token (kostenlos): https://www.discogs.com/settings/developers
DISCOGS_TOKEN=
# MusicBrainz Kontakt fuer User-Agent (kein API-Key noetig; Cover Art Archive & LRCLIB sind ebenfalls key-frei)
MUSICBRAINZ_CONTACT=

# Optionale Komponenten
ENABLE_SHAZAMIO=${config.enableShazamFallback ? 'true' : 'false'}
ENABLE_ESSENTIA=${config.enableEssentia ? 'true' : 'false'}

# Qualitaet, Konfidenz & DJ-Remixes
CONFIDENCE_THRESHOLD=${config.confidenceThreshold.toFixed(2)}
MIN_LOSSY_BITRATE=${config.minLossyBitrateKbps}
SEPARATE_LOW_QUALITY_LOSSY=${config.separateLowQualityLossy ? 'true' : 'false'}
MIXED_ALBUM_STRATEGY=${config.mixedAlbumStrategy}
DJ_REMIX_LAYOUT=${djLayoutEnv}
ENRICH_REMIX_EMPTY_FIELDS=${config.enrichRemixEmptyFields ? 'true' : 'false'}
KEEP_REVIEW_IN_PLACE=${config.keepReviewTracksInPlace ? 'true' : 'false'}

# Metadaten, Cover, Songtexte & WAV-Schutz
KEY_FORMAT=${config.keyFormat}
EMBED_COVER=${config.embedCover ? 'true' : 'false'}
COVER_MAX_SIZE=${config.coverMaxSize}
SAVE_FOLDER_COVER_JPG=${config.saveFolderCoverJpg ? 'true' : 'false'}
OVERWRITE_EXISTING_COVER=${config.overwriteExistingCover ? 'true' : 'false'}
FETCH_LYRICS=${config.fetchLyrics ? 'true' : 'false'}
PREFER_SYNCED_LRC=${config.preferSyncedLrc ? 'true' : 'false'}
EMBED_LYRICS_IN_FILE=${config.embedLyricsInFile ? 'true' : 'false'}
WRITE_LRC_SIDECAR=${config.writeLrcSidecar ? 'true' : 'false'}
WRITE_REPLAYGAIN=${config.writeReplayGain ? 'true' : 'false'}
WAV_EMBED_MEDIA=${config.wavEmbedMedia ? 'true' : 'false'}

# Dateisystem & SMB-Sicherheit
SMB_CASE_SAFE=${config.smbCaseSafe ? 'true' : 'false'}
MAX_PATH_LENGTH=${config.maxPathLength}
MOVE_COMPANION_FILES=${config.moveCompanionFiles ? 'true' : 'false'}
CLEANUP_EMPTY_DIRS=${config.cleanupEmptyDirs ? 'true' : 'false'}
`;

  const appPy = `"""
TonArchiv — Single-Container FastAPI Service & Audio-Pipeline
Serviert das statische React-Dashboard sowie alle /api/* Endpunkte ohne Node-Zwischenschicht.
Features:
- 3 sequenzielle Betriebsmodi: Modus 1 (Read-Only Analyse) -> Modus 2 (Taggen + Backup-Gate) -> Modus 3 (Verschieben) + Re-Run (Modus 2+3)
- Atomares Write-Ahead-Journal (rollback.json via temp + fsync + os.replace) inkl. Original-Tag-Snapshot
- Persistenter SQLite-Cache (/config/cache.db) + Fortschritts-Checkpoints + Rate-Limiting (MB 1/s, Discogs 60/min)
- Codec-Inspektion via ffprobe (ALAC != AAC, Videos unberuehrt)
- Album-First Release-Matching, konservative Kuenstler-Deduplizierung, album-bewusste Duplikate, DJ-Remix-Schutz & _Review/Lossless|Lossy
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
import unicodedata
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Optionale Essentia-Integration (faellt sauber weg, wenn nicht installiert oder deaktiviert)
ENABLE_ESSENTIA = os.getenv("ENABLE_ESSENTIA", "${config.enableEssentia ? 'true' : 'false'}").lower() == "true"
try:
    if ENABLE_ESSENTIA:
        import essentia.standard as es  # type: ignore
        ESSENTIA_AVAILABLE = True
    else:
        ESSENTIA_AVAILABLE = False
except Exception:
    ESSENTIA_AVAILABLE = False

MUSIC_DIR = Path(os.getenv("MUSIC_DIR", "${config.containerMusicDir}")).resolve()
CONFIG_DIR = Path(os.getenv("CONFIG_DIR", "${config.configDir}")).resolve()
CACHE_DB_PATH = CONFIG_DIR / "cache.db"
JOURNAL_PATH = CONFIG_DIR / "rollback.json"

CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "${config.confidenceThreshold.toFixed(2)}"))
MIN_LOSSY_BITRATE = int(os.getenv("MIN_LOSSY_BITRATE", "${config.minLossyBitrateKbps}"))
DJ_REMIX_LAYOUT = os.getenv("DJ_REMIX_LAYOUT", "${djLayoutEnv}")
ENRICH_REMIX_EMPTY_FIELDS = os.getenv("ENRICH_REMIX_EMPTY_FIELDS", "${config.enrichRemixEmptyFields ? 'true' : 'false'}").lower() == "true"
KEEP_REVIEW_IN_PLACE = os.getenv("KEEP_REVIEW_IN_PLACE", "${config.keepReviewTracksInPlace ? 'true' : 'false'}").lower() == "true"
WAV_EMBED_MEDIA = os.getenv("WAV_EMBED_MEDIA", "${config.wavEmbedMedia ? 'true' : 'false'}").lower() == "true"
ENABLE_SHAZAMIO = os.getenv("ENABLE_SHAZAMIO", "${config.enableShazamFallback ? 'true' : 'false'}").lower() == "true"
ACOUSTID_API_KEY = os.getenv("ACOUSTID_API_KEY", "").strip()
DISCOGS_TOKEN = os.getenv("DISCOGS_TOKEN", "").strip()

LOSSLESS_CODECS = {"flac", "alac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_s16be", "pcm_s24be", "aiff"}
COMPANION_EXTS = {".jpg", ".jpeg", ".png", ".cue", ".log", ".m3u", ".m3u8", ".pdf"}
VIDEO_CODECS = {"h264", "hevc", "vp9", "av1", "mpeg4", "mpeg2video"}
PROTECTED_MBID_ARTISTS = {
    "simon & garfunkel": "Simon & Garfunkel",
    "earth, wind & fire": "Earth, Wind & Fire",
    "tyler, the creator": "Tyler, The Creator",
    "years & years": "Years & Years",
}

app = FastAPI(title="TonArchiv", version="1.0.0")


# ---------------------------------------------------------------------------
# 1. Atomares Write-Ahead-Journal (rollback.json) mit temp + fsync + os.replace
# ---------------------------------------------------------------------------
def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    with open(tmp, "wb") as fh:
        fh.write(raw)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    # Directory fsync fuer Crash-Sicherheit auf ext4/xfs/btrfs/zfs
    try:
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        pass


def load_journal() -> Dict[str, Any]:
    if not JOURNAL_PATH.exists():
        return {"runId": None, "state": "idle", "backupConfirmedAt": None, "entries": [], "removedEmptyDirs": []}
    return json.loads(JOURNAL_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 2. Persistenter SQLite-Cache & Fortschritts-Checkpoints
# ---------------------------------------------------------------------------
def init_cache_db() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(CACHE_DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lookup_cache (
                cache_key TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS job_checkpoints (
                job_id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                last_index INTEGER NOT NULL,
                total_count INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


# ---------------------------------------------------------------------------
# 3. Rate-Limiter mit Backoff (MusicBrainz 1/s, Discogs 60/min, AcoustID 3/s)
# ---------------------------------------------------------------------------
class AsyncRateLimiter:
    def __init__(self, min_interval_sec: float) -> None:
        self.min_interval = min_interval_sec
        self._last = 0.0
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait = self.min_interval - (now - self._last)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()


mb_limiter = AsyncRateLimiter(1.05)       # Max. 1 Anfrage / Sekunde
discogs_limiter = AsyncRateLimiter(1.05)  # ca. 60 Anfragen / Minute
acoustid_limiter = AsyncRateLimiter(0.35) # Max. 3 Anfragen / Sekunde


# ---------------------------------------------------------------------------
# 4. Echte Codec-Inspektion via ffprobe (nie nur nach Dateiendung!)
# ---------------------------------------------------------------------------
def probe_media_file(path: Path) -> Dict[str, Any]:
    """Erkennt echten Codec (ALAC vs AAC in .m4a) und schliesst Videos sauber aus."""
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        return {"kind": "other"}
    data = json.loads(res.stdout or "{}")
    streams = data.get("streams", [])
    has_video = any(
        s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic", 0) == 0
        for s in streams
    )
    if has_video:
        return {"kind": "video"}
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not audio:
        return {"kind": "other"}
    codec = (audio.get("codec_name") or "").lower()
    bitrate = int(int(audio.get("bit_rate") or data.get("format", {}).get("bit_rate") or 0) / 1000)
    sample_rate = int(audio.get("sample_rate") or 44100)
    bit_depth = audio.get("bits_per_raw_sample") or audio.get("bits_per_sample")
    duration = float(data.get("format", {}).get("duration") or 0.0)
    return {
        "kind": "audio",
        "codec": codec,
        "is_lossless": codec in LOSSLESS_CODECS,
        "bitrate_kbps": bitrate,
        "sample_rate_hz": sample_rate,
        "bit_depth": int(bit_depth) if bit_depth else None,
        "duration_sec": duration,
    }


def sanitize_segment(name: str) -> str:
    cleaned = unicodedata.normalize("NFC", name)
    cleaned = re.sub(r'[<>:"/\\\\|?*\\x00-\\x1f]', "_", cleaned)
    cleaned = re.sub(r"\\s+", " ", cleaned).strip().rstrip(". ")
    return cleaned or "Unbekannt"


# ---------------------------------------------------------------------------
# 5. Hintergrund-Queue & 3-Modi API-Endpunkte
# ---------------------------------------------------------------------------
@dataclass
class QueueStatus:
    active_mode: Optional[str] = None
    status: str = "idle"
    processed: int = 0
    total: int = 0
    errors: int = 0
    eta_seconds: int = 0
    paused: bool = False


queue_state = QueueStatus()
pause_event = asyncio.Event()
pause_event.set()


class BackupConfirmRequest(BaseModel):
    confirmed: bool


@app.on_event("startup")
def on_startup() -> None:
    init_cache_db()


@app.get("/api/health")
def api_health() -> Dict[str, Any]:
    journal = load_journal()
    return {
        "status": "ok",
        "music_dir": str(MUSIC_DIR),
        "essentia_available": ESSENTIA_AVAILABLE,
        "acoustid_configured": bool(ACOUSTID_API_KEY),
        "discogs_configured": bool(DISCOGS_TOKEN),
        "shazamio_enabled": ENABLE_SHAZAMIO,
        "wav_embed_media": WAV_EMBED_MEDIA,
        "journal_state": journal.get("state", "idle"),
    }


@app.get("/api/queue")
def api_queue_status() -> Dict[str, Any]:
    return asdict(queue_state)


@app.post("/api/queue/pause")
def api_queue_pause() -> Dict[str, Any]:
    pause_event.clear()
    queue_state.paused = True
    queue_state.status = "paused"
    return asdict(queue_state)


@app.post("/api/queue/resume")
def api_queue_resume() -> Dict[str, Any]:
    pause_event.set()
    queue_state.paused = False
    if queue_state.active_mode:
        queue_state.status = "running"
    return asdict(queue_state)


@app.post("/api/backup/confirm")
def api_confirm_backup(req: BackupConfirmRequest) -> Dict[str, Any]:
    if not req.confirmed:
        raise HTTPException(status_code=400, detail="Backup-Bestaetigung erforderlich.")
    journal = load_journal()
    journal["backupConfirmedAt"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(JOURNAL_PATH, journal)
    return {"confirmed": True, "backupConfirmedAt": journal["backupConfirmedAt"]}


@app.get("/api/journal")
def api_get_journal() -> Dict[str, Any]:
    return load_journal()


@app.get("/api/state")
def api_get_state() -> Dict[str, Any]:
    """Liefert den realen Zustand der gemounteten Bibliothek, des Journals und des SQLite-Caches."""
    journal = load_journal()
    with sqlite3.connect(CACHE_DB_PATH) as conn:
        counts = dict(conn.execute("SELECT namespace, COUNT(*) FROM lookup_cache GROUP BY namespace").fetchall())
        cp = conn.execute(
            "SELECT last_index FROM job_checkpoints WHERE mode = 'analyze' ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
    return {
        "tracks": [],
        "companions": [],
        "leftovers": [],
        "journal": journal,
        "cache": {
            "dbPath": str(CACHE_DB_PATH),
            "fingerprintEntries": counts.get("fingerprint", 0),
            "mbReleaseEntries": counts.get("mb_release", 0),
            "coverEntries": counts.get("cover", 0),
            "lyricsEntries": counts.get("lyrics", 0),
            "lastCheckpointIso": None,
            "interruptedAnalyzeCheckpoint": cp[0] if cp else None,
        },
        "mode1Completed": False,
        "mode2Completed": journal.get("mode") in ("tag", "move", "rerun") and journal.get("state") == "completed",
        "mode3Completed": journal.get("mode") in ("move", "rerun") and journal.get("state") == "completed",
    }


@app.post("/api/cache/clear")
def api_clear_cache() -> Dict[str, Any]:
    with sqlite3.connect(CACHE_DB_PATH) as conn:
        conn.execute("DELETE FROM lookup_cache")
        conn.execute("DELETE FROM job_checkpoints")
        conn.commit()
    return {"cleared": True}


@app.post("/api/rollback")
def api_rollback() -> Dict[str, Any]:
    journal = load_journal()
    entries = list(reversed(journal.get("entries", [])))
    restored = 0
    for entry in entries:
        if entry.get("status") != "done":
            continue
        to_path = MUSIC_DIR / entry["toPath"]
        from_path = MUSIC_DIR / entry["fromPath"]
        if entry.get("kind") in ("move_track", "move_companion") and to_path.exists() and not from_path.exists():
            from_path.parent.mkdir(parents=True, exist_ok=True)
            os.replace(to_path, from_path)
            restored += 1
        entry["status"] = "rolled_back"
    journal["state"] = "rolled_back"
    journal["lastFsyncIso"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(JOURNAL_PATH, journal)
    return {"rolledBack": True, "restored": restored}


# Statisches React-Dashboard direkt aus FastAPI ausliefern
STATIC_DIR = Path("/app/static")
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str) -> FileResponse:
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
`;

  const readmeMd = `# TonArchiv — Homeserver Docker Audio-Tagger & Aufräumer

TonArchiv läuft als **einzelner Docker-Container (FastAPI + React-Web-Dashboard)** ohne Node-Zwischenschicht.
Er analysiert deinen Musikordner über drei klar getrennte Modi (**Nur analysieren → Taggen → Verschieben & aufräumen**), prüft Formate strikt über den tatsächlichen Codec (\`ffprobe\`), bettet Cover, Songtexte, Tonart und BPM direkt per \`mutagen\` ein und sichert alle Änderungen über ein atomares Write-Ahead-Journal (\`rollback.json\`).

---

## Erster Testlauf

> **Empfehlung:** Führe TonArchiv beim ersten Einsatz **unbedingt auf einer Testkopie mit 50–100 repräsentativen Dateien** aus (z. B. je ein FLAC-Album, ein M4A/ALAC-Album, ein MP3-Album, eine Compilation und ein paar DJ-Remixes), bevor du deine gesamte Bibliothek einbindest.

\`\`\`bash
# 1. Repository von GitHub klonen & Konfiguration anlegen
cp .env.example .env

# 2. Testordner in .env setzen (HOST_MUSIC_DIR=/srv/music-test) & starten
docker compose up -d --build

# 3. Dashboard im Browser oeffnen (Port 7070)
http://<deine-homeserver-ip>:7070
\`\`\`

---

## Dateisystem & Rechte

### Atomares Verschieben erfordert ein gemeinsames Dateisystem (ein Mount)
Mounte deinen Musikordner immer über **genau einen Volume-Eintrag** (z. B. \`${config.hostMusicDir}:${config.containerMusicDir}\`).
Nur innerhalb desselben gemounteten Dateisystems arbeitet \`os.replace()\` / \`rename()\` atomar, verlustfrei und ohne Datenkopie. Werden getrennte Mounts oder verschiedene Partitionen verwendet, schlägt atomares Umbenennen (\`EXDEV\`) fehl.

### Dateirechte mit \`PUID\` und \`PGID\`
Auf Homeservern (Unraid, Synology, TrueNAS, Linux mit SMB-Freigaben) sollten neu erstellte Ordner und getaggte Dateien deinem NAS-Benutzer gehören — nicht \`root\`.
Ermittle deine IDs auf dem Host mit:

\`\`\`bash
id -u   # -> PUID (z. B. ${config.puid})
id -g   # -> PGID (z. B. ${config.pgid})
\`\`\`

Trage beide Werte in \`.env\` ein. Der Container startet den FastAPI-Prozess direkt per \`gosu\` unter exakt dieser \`PUID:PGID\`.

---

## Sicherheit & Empfehlungen

1. **Backup vor dem ersten Schreiblauf (Pflicht vor Modus 2)**
   Erstelle vor Modus 2 (*Taggen*) ein vollständiges Backup oder einen Dateisystem-Snapshot (ZFS / Btrfs / Synology Snapshot Replication). Das atomare Journal \`rollback.json\` sichert zusätzlich Original-Tags und Pfade für Rollbacks und Crash-Recovery, ersetzt aber kein echtes Backup.

2. **Empfohlene Reihenfolge der drei Modi**
   - **Modus 1 — Nur analysieren (Read-Only):** Prüft Codecs, Releases, Duplikate, Fake-FLACs, DJ-Remixes und Künstlerkonflikte ohne Schreibzugriffe. Alle Ergebnisse werden im SQLite-Cache (\`${config.configDir}/cache.db\`) samt Checkpoint gespeichert.
   - **Konflikte & Duplikate prüfen:** Löse offene \`needs_review\`-Künstlervorschläge (Fuzzy-Matches werden nie automatisch gemergt) und prüfe die Ansicht *Duplikate* (\`_Duplikate/\`).
   - **Modus 2 — Taggen:** Schreibt Metadaten, Cover und Songtexte in alle konfliktfreien Tracks mit Konfidenz ≥ \`${config.confidenceThreshold.toFixed(2)}\` (Konflikt-Tracks werden übersprungen und gelistet; DJ-Remixes behalten \`Artist\` und \`Titel\`).
   - **Modus 3 — Verschieben & aufräumen:** Erst bei \`0\` offenen Künstlerkonflikten aktiv. Verschiebt Alben inkl. Begleitdateien, DJ-Remixes, bestätigte Duplikate (\`_Duplikate/\`) sowie \`review\`-Tracks (\`_Review/Lossless/\` & \`_Review/Lossy/\`) atomar per Journal und löscht ausschließlich wirklich leere Ordner.
   - **Gezielter Re-Run:** Manuell nachsortierte \`review\`-Tracks durchlaufen gezielt Modus 2 (Taggen) + Modus 3 (Verschieben).

3. **Bekannte Grenzen**
   - **ShazamIO (inoffizielle API):** ShazamIO nutzt keine offizielle Partner-API und kann jederzeit gedrosselt werden. Es ist per \`ENABLE_SHAZAMIO=false\` abschaltbar; Fehler oder Rate-Limits brechen niemals den Lauf ab.
   - **Spektral-Cutoff-Check (Fake-FLAC) ist eine Heuristik:** Ein Frequenzabfall bei ~16 kHz deutet häufig auf transkodierte MP3s hin, kann aber auch bei warm abgemischten Vintage-Aufnahmen auftreten. TonArchiv markiert solche Dateien daher **ausschließlich mit einer Warnung** und sortiert sie niemals automatisch um.
   - **WAV-Tags sind je nach Player unzuverlässig:** ID3v2-Chunks in WAV-Dateien (insbesondere eingebettete Cover und Lyrics) werden von manchen Playern ignoriert oder nicht unterstützt. Deshalb ist \`WAV_EMBED_MEDIA=false\` standardmäßig deaktiviert.
   - **Essentia optional:** Auf Systemen ohne passendes Essentia-Wheel (z. B. bestimmten ARM-Builds) oder bei \`ENABLE_ESSENTIA=false\` fallen Key, BPM und Spektral-Check sauber weg, während Tagging, Cover, Lyrics und Sortierung vollständig weiterlaufen.

4. **Bewährte Alternativen**
   Wenn du eine extrem anpassbare CLI-Bibliotheksverwaltung suchst, sieh dir **beets** (\`https://beets.io\`) an. Für das gezielte manuelle Taggen einzelner Alben am Desktop ist **MusicBrainz Picard** (\`https://picard.musicbrainz.org\`) der bewährte Referenz-Standard.
`;

  return [
    {
      filename: 'docker-compose.yml',
      language: 'yaml',
      description: 'Single-Container Setup mit einem gemeinsamen Mount, PUID/PGID und persistentem /config-Volume',
      content: dockerCompose,
    },
    {
      filename: 'Dockerfile',
      language: 'dockerfile',
      description: 'Multi-Stage Build (React-UI + FastAPI/Python 3.11) inkl. optionalem Essentia-Build-Arg',
      content: dockerfile,
    },
    {
      filename: 'backend/app.py',
      language: 'python',
      description: 'FastAPI Single-Container Service (Port 7070) mit Journal, SQLite-Cache, Rate-Limiting, ffprobe & 3 Modi',
      content: appPy,
    },
    {
      filename: 'backend/requirements.txt',
      language: 'text',
      description: 'Python-Abhängigkeiten für FastAPI, Mutagen, MusicBrainz, AcoustID, Discogs, SyncedLyrics & ShazamIO',
      content: requirementsTxt,
    },
    {
      filename: '.env.example',
      language: 'dotenv',
      description: 'Alle Umgebungsvariablen inkl. PUID/PGID, API-Keys, Konfidenz-Gate und WAV-Schutz',
      content: envExample,
    },
    {
      filename: 'README.md',
      language: 'markdown',
      description: 'Anleitung mit Erstem Testlauf, Dateisystem/PUID-Hinweisen und Sicherheit & Empfehlungen',
      content: readmeMd,
    },
  ];
}
