"""
TonArchiv — Single-Container FastAPI Service & Audio-Pipeline (Port 7070)
Plug-and-Play Container: pullen, Umgebungsvariablen eintragen, laeuft vollstaendig autonom.

Features:
- Liest alle Konfigurationen & API-Keys automatisch aus Environment-Variablen
- Optionaler Read-Only Autostart (AUTO_ANALYZE_ON_START=true) beim Booten
- 3 sequenzielle Betriebsmodi:
    Modus 1 (Read-Only Analyse) -> Modus 2 (Taggen + Backup-Gate) -> Modus 3 (Atomares Verschieben)
    + Gezielter Re-Run (Modus 2 + Modus 3 nacheinander fuer nachsortierte review-Tracks)
- Atomares Write-Ahead-Journal (/config/rollback.json via temp + fsync + os.replace)
- Persistenter SQLite-Cache (/config/cache.db) + Checkpoints + Rate-Limiting (MB 1/s, Discogs 60/min, AcoustID 3/s)
- Echte Codec-Inspektion via ffprobe + Mutagen Tag-Lesen & -Schreiben (ALAC != AAC, Videos immer unberuehrt)
"""

from __future__ import annotations

import asyncio
import difflib
import gc
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from mutagen import File as MutagenFile  # type: ignore
    from mutagen.flac import FLAC, Picture  # type: ignore
    from mutagen.id3 import APIC, ID3, SYLT, USLT, ID3NoHeaderError  # type: ignore
    from mutagen.mp4 import MP4, MP4Cover  # type: ignore
except Exception:
    MutagenFile = None
    FLAC = None
    Picture = None
    ID3 = None
    APIC = None
    USLT = None
    SYLT = None
    ID3NoHeaderError = Exception
    MP4 = None
    MP4Cover = None


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return default


# Optionale Essentia-Integration (faellt sauber weg, wenn nicht installiert oder deaktiviert)
ENABLE_ESSENTIA = _env_bool("ENABLE_ESSENTIA", False)
try:
    if ENABLE_ESSENTIA:
        import essentia.standard as es  # type: ignore  # noqa: F401

        ESSENTIA_AVAILABLE = True
    else:
        ESSENTIA_AVAILABLE = False
except Exception:
    ESSENTIA_AVAILABLE = False

# Optionale ShazamIO Audio-Fingerprint-Erkennung (funktioniert ohne API-Key ueber ffmpeg)
try:
    from shazamio import Shazam as _ShazamClient  # type: ignore

    SHAZAMIO_AVAILABLE = True
except Exception:
    _ShazamClient = None
    SHAZAMIO_AVAILABLE = False

MUSIC_DIR = Path(os.getenv("MUSIC_DIR", "/music")).resolve()
CONFIG_DIR = Path(os.getenv("CONFIG_DIR", "/config")).resolve()
CACHE_DB_PATH = CONFIG_DIR / "cache.db"
JOURNAL_PATH = CONFIG_DIR / "rollback.json"
STATE_PATH = CONFIG_DIR / "state.json"

PUID = _env_int("PUID", 1000)
PGID = _env_int("PGID", 1000)
HOST_MUSIC_DIR = os.getenv("HOST_MUSIC_DIR", "/srv/Music Full Quality")
AUTO_ANALYZE_ON_START = _env_bool("AUTO_ANALYZE_ON_START", False)


def _path_exists_safe(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False

CONFIDENCE_THRESHOLD = _env_float("CONFIDENCE_THRESHOLD", 0.80)
MIN_LOSSY_BITRATE = _env_int("MIN_LOSSY_BITRATE", 256)
SEPARATE_LOW_QUALITY_LOSSY = _env_bool("SEPARATE_LOW_QUALITY_LOSSY", True)
MIXED_ALBUM_STRATEGY = os.getenv("MIXED_ALBUM_STRATEGY", "lowest_quality")
DJ_REMIX_LAYOUT = os.getenv("DJ_REMIX_LAYOUT", "root_folder")
ENRICH_REMIX_EMPTY_FIELDS = _env_bool("ENRICH_REMIX_EMPTY_FIELDS", True)
KEEP_REVIEW_IN_PLACE = _env_bool("KEEP_REVIEW_IN_PLACE", False)
KEY_FORMAT = os.getenv("KEY_FORMAT", "both")
EMBED_COVER = _env_bool("EMBED_COVER", True)
COVER_MAX_SIZE = _env_int("COVER_MAX_SIZE", 1000)
SAVE_FOLDER_COVER_JPG = _env_bool("SAVE_FOLDER_COVER_JPG", True)
OVERWRITE_EXISTING_COVER = _env_bool("OVERWRITE_EXISTING_COVER", False)
FETCH_LYRICS = _env_bool("FETCH_LYRICS", True)
PREFER_SYNCED_LRC = _env_bool("PREFER_SYNCED_LRC", True)
EMBED_LYRICS_IN_FILE = _env_bool("EMBED_LYRICS_IN_FILE", True)
WRITE_LRC_SIDECAR = _env_bool("WRITE_LRC_SIDECAR", False)
WRITE_REPLAYGAIN = _env_bool("WRITE_REPLAYGAIN", True)
WAV_EMBED_MEDIA = _env_bool("WAV_EMBED_MEDIA", False)
SMB_CASE_SAFE = _env_bool("SMB_CASE_SAFE", True)
MAX_PATH_LENGTH = _env_int("MAX_PATH_LENGTH", 240)
MOVE_COMPANION_FILES = _env_bool("MOVE_COMPANION_FILES", True)
CLEANUP_EMPTY_DIRS = _env_bool("CLEANUP_EMPTY_DIRS", True)
ENABLE_SHAZAMIO = _env_bool("ENABLE_SHAZAMIO", True)

ACOUSTID_API_KEY = os.getenv("ACOUSTID_API_KEY", "").strip()
DISCOGS_TOKEN = os.getenv("DISCOGS_TOKEN", "").strip()
MUSICBRAINZ_CONTACT = (
    os.getenv("MUSICBRAINZ_CONTACT", "").strip() or "https://github.com/tonarchiv"
)
MB_USER_AGENT = f"TonArchiv/1.0 ({MUSICBRAINZ_CONTACT})"


def build_server_config() -> Dict[str, Any]:
    return {
        "hostMusicDir": HOST_MUSIC_DIR,
        "containerMusicDir": str(MUSIC_DIR),
        "configDir": str(CONFIG_DIR),
        "puid": PUID,
        "pgid": PGID,
        "minLossyBitrateKbps": MIN_LOSSY_BITRATE,
        "separateLowQualityLossy": SEPARATE_LOW_QUALITY_LOSSY,
        "mixedAlbumStrategy": (
            MIXED_ALBUM_STRATEGY
            if MIXED_ALBUM_STRATEGY in ("lowest_quality", "manual_review")
            else "lowest_quality"
        ),
        "djRemixLayout": (
            DJ_REMIX_LAYOUT
            if DJ_REMIX_LAYOUT in ("root_folder", "split_by_quality")
            else "root_folder"
        ),
        "enrichRemixEmptyFields": ENRICH_REMIX_EMPTY_FIELDS,
        "keepReviewTracksInPlace": KEEP_REVIEW_IN_PLACE,
        "confidenceThreshold": CONFIDENCE_THRESHOLD,
        "enableShazamFallback": ENABLE_SHAZAMIO,
        "shazamioAvailable": SHAZAMIO_AVAILABLE,
        "enableEssentia": ENABLE_ESSENTIA,
        "essentiaAvailable": ESSENTIA_AVAILABLE,
        "acoustidKeyConfigured": bool(ACOUSTID_API_KEY),
        "discogsTokenConfigured": bool(DISCOGS_TOKEN),
        "keyFormat": KEY_FORMAT if KEY_FORMAT in ("both", "camelot", "musical") else "both",
        "embedCover": EMBED_COVER,
        "coverMaxSize": COVER_MAX_SIZE,
        "saveFolderCoverJpg": SAVE_FOLDER_COVER_JPG,
        "overwriteExistingCover": OVERWRITE_EXISTING_COVER,
        "fetchLyrics": FETCH_LYRICS,
        "preferSyncedLrc": PREFER_SYNCED_LRC,
        "embedLyricsInFile": EMBED_LYRICS_IN_FILE,
        "writeLrcSidecar": WRITE_LRC_SIDECAR,
        "writeReplayGain": WRITE_REPLAYGAIN,
        "wavEmbedMedia": WAV_EMBED_MEDIA,
        "smbCaseSafe": SMB_CASE_SAFE,
        "maxPathLength": MAX_PATH_LENGTH,
        "moveCompanionFiles": MOVE_COMPANION_FILES,
        "cleanupEmptyDirs": CLEANUP_EMPTY_DIRS,
    }


LOSSLESS_CODECS = {
    "flac",
    "alac",
    "pcm_s16le",
    "pcm_s24le",
    "pcm_s32le",
    "pcm_s16be",
    "pcm_s24be",
    "aiff",
}
AUDIO_EXTS = {
    ".flac",
    ".mp3",
    ".m4a",
    ".mp4",
    ".ogg",
    ".oga",
    ".opus",
    ".wav",
    ".aiff",
    ".aif",
    ".wma",
    ".alac",
}
VIDEO_EXTS = {".mkv", ".avi", ".mov", ".webm", ".wmv", ".m4v", ".ts", ".mpeg", ".mpg"}
COMPANION_EXTS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".cue",
    ".log",
    ".m3u",
    ".m3u8",
    ".pdf",
    ".nfo",
    ".lrc",
    ".txt",
}

app = FastAPI(title="TonArchiv", version="1.2.0")

cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)

_HTTP_SESSION = requests.Session()


# ---------------------------------------------------------------------------
# 1. Atomares Write-Ahead-Journal & State-Persistenz (temp + fsync + os.replace)
# ---------------------------------------------------------------------------
_STATE_CACHE: Optional[Dict[str, Any]] = None


def atomic_write_json(path: Path, payload: Dict[str, Any], compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    if compact:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    else:
        raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    with open(tmp, "wb") as fh:
        fh.write(raw)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
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
        return {
            "runId": None,
            "mode": "idle",
            "state": "idle",
            "backupConfirmedAt": None,
            "lastFsyncIso": None,
            "entries": [],
            "removedEmptyDirs": [],
        }
    try:
        return json.loads(JOURNAL_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {
            "runId": None,
            "mode": "idle",
            "state": "idle",
            "backupConfirmedAt": None,
            "lastFsyncIso": None,
            "entries": [],
            "removedEmptyDirs": [],
        }


def _normalize_release_obj(rel: Any, fallback_duration: int = 0) -> Optional[Dict[str, Any]]:
    if not isinstance(rel, dict):
        return None
    normalized = dict(rel)
    if normalized.get("matchScore") is None:
        normalized["matchScore"] = 0.85
    if not normalized.get("format"):
        normalized["format"] = "Digital Media"
    raw_tl = normalized.get("tracklist")
    fixed_tl: List[Dict[str, Any]] = []
    if isinstance(raw_tl, list):
        for i, item in enumerate(raw_tl, start=1):
            if isinstance(item, dict):
                fixed_tl.append(
                    {
                        "position": int(item.get("position") or i),
                        "title": str(item.get("title") or ""),
                        "durationSec": int(item.get("durationSec") or fallback_duration or 0),
                    }
                )
            elif isinstance(item, str):
                fixed_tl.append(
                    {
                        "position": i,
                        "title": item,
                        "durationSec": int(fallback_duration or 0),
                    }
                )
    normalized["tracklist"] = fixed_tl
    return normalized


def _normalize_track_obj(t: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(t, dict) or not t.get("id"):
        return None
    dur = int(t.get("durationSec") or 0)
    orig = t.get("originalTags")
    if not isinstance(orig, dict):
        orig = {}
    cov = t.get("cover")
    if not isinstance(cov, dict):
        cov = {}
    lyr = t.get("lyrics")
    if not isinstance(lyr, dict):
        lyr = {}

    t["sourceRelativePath"] = str(t.get("sourceRelativePath") or t.get("fileName") or "")
    t["sourceDir"] = str(t.get("sourceDir") or "")
    t["fileName"] = str(t.get("fileName") or Path(t["sourceRelativePath"]).name or "Unbekannt")
    ext = str(t.get("extension") or Path(t["fileName"]).suffix or ".mp3").lower()
    t["extension"] = ext if ext.startswith(".") else f".{ext}"
    t["codec"] = str(t.get("codec") or "mp3").lower()
    t["sizeBytes"] = int(t.get("sizeBytes") or 0)
    t["mtimeIso"] = str(t.get("mtimeIso") or "1970-01-01T00:00:00+00:00")
    t["durationSec"] = dur
    t["bitrateKbps"] = int(t.get("bitrateKbps") or 0)
    t["sampleRateHz"] = int(t.get("sampleRateHz") or 44100)
    t["artist"] = str(t.get("artist") or orig.get("artist") or "Unbekannter Kuenstler")
    t["albumArtist"] = str(t.get("albumArtist") or orig.get("albumArtist") or t["artist"])
    t["title"] = str(t.get("title") or orig.get("title") or Path(t["fileName"]).stem)
    t["album"] = str(t.get("album") or orig.get("album") or "")
    t["year"] = str(t.get("year") or orig.get("year") or "")
    t["trackNumber"] = str(t.get("trackNumber") or orig.get("trackNumber") or "")
    t["genre"] = str(t.get("genre") or orig.get("genre") or "")
    t["isrc"] = str(t.get("isrc") or "")
    t["compilationFlag"] = bool(t.get("compilationFlag"))
    t["acoustidConfidence"] = float(t.get("acoustidConfidence") or 0.0)
    t["activeSource"] = str(t.get("activeSource") or "musicbrainz")
    t["sourceCandidates"] = t.get("sourceCandidates") if isinstance(t.get("sourceCandidates"), list) else []
    t["musicalKey"] = str(t.get("musicalKey") or "—")
    t["camelotKey"] = str(t.get("camelotKey") or "—")
    t["manualAssignment"] = str(t.get("manualAssignment") or "none")
    t["status"] = str(t.get("status") or "pending")
    t["lookupError"] = str(t["lookupError"]) if t.get("lookupError") else None
    t["originalTags"] = {
        "artist": str(orig.get("artist") or ""),
        "albumArtist": str(orig.get("albumArtist") or ""),
        "title": str(orig.get("title") or ""),
        "album": str(orig.get("album") or ""),
        "year": str(orig.get("year") or ""),
        "trackNumber": str(orig.get("trackNumber") or ""),
        "genre": str(orig.get("genre") or ""),
        "key": str(orig.get("key") or ""),
        "bpm": orig.get("bpm") if isinstance(orig.get("bpm"), (int, float)) else None,
        "compilation": bool(orig.get("compilation")),
    }
    t["cover"] = {
        "status": str(cov.get("status") or "missing"),
        "source": str(cov.get("source") or "Keine"),
        "resolution": str(cov.get("resolution") or "—"),
        "sizeKb": int(cov.get("sizeKb") or 0),
        "embeddedBefore": bool(cov.get("embeddedBefore")),
        "imageUrl": cov.get("imageUrl"),
        "fallbackGradient": str(cov.get("fallbackGradient") or "from-slate-800 to-slate-900"),
    }
    t["lyrics"] = {
        "status": str(lyr.get("status") or "missing"),
        "source": str(lyr.get("source") or "Keine"),
        "syncedLrc": str(lyr.get("syncedLrc") or ""),
        "plainText": str(lyr.get("plainText") or ""),
    }
    if t.get("matchedRelease"):
        t["matchedRelease"] = _normalize_release_obj(t["matchedRelease"], dur)
    else:
        t["matchedRelease"] = None
    if isinstance(t.get("availableReleases"), list):
        t["availableReleases"] = [
            r
            for r in (_normalize_release_obj(x, dur) for x in t["availableReleases"])
            if r is not None
        ]
    else:
        t["availableReleases"] = []
    return t


def _normalize_state_compat(data: Dict[str, Any]) -> Dict[str, Any]:
    tracks = data.get("tracks")
    if isinstance(tracks, list):
        normalized_tracks = []
        for t in tracks:
            nt = _normalize_track_obj(t)
            if nt is not None:
                normalized_tracks.append(nt)
        data["tracks"] = normalized_tracks
    else:
        data["tracks"] = []
    if not isinstance(data.get("companions"), list):
        data["companions"] = []
    if not isinstance(data.get("leftovers"), list):
        data["leftovers"] = []
    return data


def _compact_track_for_bulk_state(t: Dict[str, Any]) -> Dict[str, Any]:
    """Kuerzt schwere Text-Blobs (Lyrics-Volltext, ueberzaehlige Releases) fuer schnelles /api/state auf Mobilgeraeten."""
    lyr = t.get("lyrics") if isinstance(t.get("lyrics"), dict) else {}
    avail = t.get("availableReleases") if isinstance(t.get("availableReleases"), list) else []
    compact_avail = [
        {**r, "tracklist": (r.get("tracklist") or [])[:5]}
        for r in avail[:3]
        if isinstance(r, dict)
    ]
    matched = t.get("matchedRelease")
    if isinstance(matched, dict):
        matched = {**matched, "tracklist": (matched.get("tracklist") or [])[:25]}
    return {
        **t,
        "matchedRelease": matched,
        "availableReleases": compact_avail,
        "lyrics": {
            "status": lyr.get("status", "missing"),
            "source": lyr.get("source", "Keine"),
            "syncedLrc": "",
            "plainText": "",
        },
    }


def load_persisted_state() -> Optional[Dict[str, Any]]:
    global _STATE_CACHE
    if _STATE_CACHE is not None:
        return _STATE_CACHE
    if not STATE_PATH.exists():
        return None
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            _STATE_CACHE = _normalize_state_compat(data)
            return _STATE_CACHE
        return None
    except Exception:
        return None


def save_persisted_state(state: Dict[str, Any]) -> None:
    global _STATE_CACHE
    _STATE_CACHE = state
    atomic_write_json(STATE_PATH, state, compact=True)


def safe_resolve_under_music(rel_path: str) -> Path:
    cleaned = rel_path.lstrip("/\\")
    candidate = (MUSIC_DIR / cleaned).resolve()
    try:
        candidate.relative_to(MUSIC_DIR)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"Ungueltiger Pfad ausserhalb von MUSIC_DIR: {rel_path}"
        ) from exc
    return candidate


# ---------------------------------------------------------------------------
# 2. Persistenter SQLite-Cache & Fortschritts-Checkpoints
# ---------------------------------------------------------------------------
def _create_cache_tables(db_path: Path) -> None:
    with sqlite3.connect(db_path, timeout=10.0) as conn:
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


def init_cache_db() -> None:
    global CONFIG_DIR, CACHE_DB_PATH, JOURNAL_PATH, STATE_PATH
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        probe = CONFIG_DIR / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        _create_cache_tables(CACHE_DB_PATH)
    except (OSError, sqlite3.Error) as exc:
        print(
            f"[TonArchiv] Warnung: CONFIG_DIR={CONFIG_DIR} nicht nutzbar ({exc}) — weiche auf /tmp/tonarchiv-config aus.",
            flush=True,
        )
        CONFIG_DIR = Path("/tmp/tonarchiv-config")
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CACHE_DB_PATH = CONFIG_DIR / "cache.db"
        JOURNAL_PATH = CONFIG_DIR / "rollback.json"
        STATE_PATH = CONFIG_DIR / "state.json"
        _create_cache_tables(CACHE_DB_PATH)


def cache_get(namespace: str, cache_key: str) -> Optional[Dict[str, Any]]:
    full_key = f"{namespace}:{cache_key}"
    with sqlite3.connect(CACHE_DB_PATH, timeout=10.0) as conn:
        row = conn.execute(
            "SELECT payload_json FROM lookup_cache WHERE cache_key = ?", (full_key,)
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except Exception:
        return None


def cache_put(namespace: str, cache_key: str, payload: Dict[str, Any]) -> None:
    full_key = f"{namespace}:{cache_key}"
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(CACHE_DB_PATH, timeout=10.0) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO lookup_cache (cache_key, namespace, payload_json, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (full_key, namespace, json.dumps(payload, ensure_ascii=False), now),
        )
        conn.commit()


def save_checkpoint(mode: str, last_index: int, total_count: int) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(CACHE_DB_PATH, timeout=10.0) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO job_checkpoints (job_id, mode, last_index, total_count, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (f"latest-{mode}", mode, last_index, total_count, now),
        )
        conn.commit()


def clear_checkpoint(mode: str) -> None:
    with sqlite3.connect(CACHE_DB_PATH, timeout=10.0) as conn:
        conn.execute("DELETE FROM job_checkpoints WHERE mode = ?", (mode,))
        conn.commit()


def read_cache_stats() -> Dict[str, Any]:
    with sqlite3.connect(CACHE_DB_PATH, timeout=10.0) as conn:
        counts = dict(
            conn.execute("SELECT namespace, COUNT(*) FROM lookup_cache GROUP BY namespace").fetchall()
        )
        cp = conn.execute(
            "SELECT last_index, updated_at FROM job_checkpoints WHERE mode = 'analyze' ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
    return {
        "dbPath": str(CACHE_DB_PATH),
        "fingerprintEntries": counts.get("fingerprint", 0),
        "mbReleaseEntries": counts.get("mb_release", 0),
        "coverEntries": counts.get("cover", 0),
        "lyricsEntries": counts.get("lyrics", 0),
        "lastCheckpointIso": cp[1] if cp else None,
        "interruptedAnalyzeCheckpoint": cp[0] if cp else None,
    }


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


mb_limiter = AsyncRateLimiter(1.05)
discogs_limiter = AsyncRateLimiter(1.05)
acoustid_limiter = AsyncRateLimiter(0.35)
deezer_limiter = AsyncRateLimiter(0.25)
shazam_limiter = AsyncRateLimiter(1.4)


# ---------------------------------------------------------------------------
# 4. Echte Codec-Inspektion via ffprobe + Mutagen (nie nur nach Dateiendung!)
# ---------------------------------------------------------------------------
def map_ffprobe_codec(raw_codec: str, ext: str, bit_depth: Optional[int]) -> str:
    c = raw_codec.lower()
    if "flac" in c:
        return "flac"
    if "alac" in c:
        return "alac"
    if "aac" in c or "mp4a" in c:
        return "aac"
    if "mp3" in c:
        return "mp3"
    if "vorbis" in c:
        return "vorbis"
    if "opus" in c:
        return "opus"
    if "wma" in c:
        return "wma"
    if ext in (".aiff", ".aif"):
        return "aiff"
    if "pcm" in c or ext == ".wav":
        return "pcm_s24le" if (bit_depth or 16) >= 24 else "pcm_s16le"
    return "aac"


def probe_media_file(path: Path) -> Dict[str, Any]:
    cmd = [
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=15)
    except Exception:
        return {"kind": "other"}
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
    raw_codec = (audio.get("codec_name") or "").lower()
    bitrate = int(int(audio.get("bit_rate") or data.get("format", {}).get("bit_rate") or 0) / 1000)
    sample_rate = int(audio.get("sample_rate") or 44100)
    bit_depth_raw = audio.get("bits_per_raw_sample") or audio.get("bits_per_sample")
    bit_depth = (
        int(bit_depth_raw)
        if bit_depth_raw and str(bit_depth_raw).isdigit() and int(bit_depth_raw) > 0
        else None
    )
    duration = round(float(data.get("format", {}).get("duration") or 0.0))
    mapped_codec = map_ffprobe_codec(raw_codec, path.suffix.lower(), bit_depth)
    return {
        "kind": "audio",
        "codec": mapped_codec,
        "bitrate_kbps": bitrate,
        "sample_rate_hz": sample_rate,
        "bit_depth": bit_depth,
        "duration_sec": duration,
        "tags": data.get("format", {}).get("tags") or {},
    }


IGNORED_DIR_NAMES = {
    "@eaDir",
    "#recycle",
    "$RECYCLE.BIN",
    "System Volume Information",
    "lost+found",
    ".git",
    ".Trash",
    ".Trash-1000",
}


def read_tags_from_file(path: Path, ffprobe_tags: Dict[str, Any]) -> Dict[str, Any]:
    tags_lower: Dict[str, str] = {
        str(k).lower(): str(v).strip() for k, v in ffprobe_tags.items() if v is not None
    }
    has_cover = False
    if MutagenFile is not None:
        mf = None
        try:
            mf = MutagenFile(str(path), easy=True)
            if mf is not None and mf.tags:
                for key in (
                    "artist",
                    "albumartist",
                    "title",
                    "album",
                    "date",
                    "tracknumber",
                    "genre",
                    "isrc",
                    "compilation",
                    "bpm",
                    "initialkey",
                    "musicbrainz_trackid",
                    "musicbrainz_artistid",
                    "acoustid_id",
                ):
                    val = mf.tags.get(key)
                    if val:
                        tags_lower[key] = str(val[0]).strip()
                if getattr(mf, "pictures", None):
                    has_cover = len(mf.pictures) > 0
        except Exception:
            pass
        finally:
            if mf is not None:
                del mf
    return {"tags": tags_lower, "has_cover": has_cover}


def inspect_audio_fast(path: Path) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Speicherschonende Codec- & Tag-Inspektion:
    - .m4a/.mp4 werden IMMER via ffprobe geprueft (ALAC vs. AAC & echte MP4-Videos sicher erkennen)
    - Alle uebrigen Audioformate (.flac, .mp3, .ogg, .opus, .wav, .aiff, .wma) laufen direkt
      ueber Mutagen ohne Subprozess-Storm und ohne Cover-Blobs dauerhaft im RAM zu halten.
    """
    ext = path.suffix.lower()
    if ext in (".m4a", ".mp4") or MutagenFile is None:
        probed = probe_media_file(path)
        if probed.get("kind") != "audio":
            return probed, {"tags": {}, "has_cover": False}
        meta = read_tags_from_file(path, probed.get("tags") or {})
        return probed, meta

    mf = None
    try:
        mf = MutagenFile(str(path), easy=True)
        if mf is None or getattr(mf, "info", None) is None:
            probed = probe_media_file(path)
            if probed.get("kind") != "audio":
                return probed, {"tags": {}, "has_cover": False}
            meta = read_tags_from_file(path, probed.get("tags") or {})
            return probed, meta

        info = mf.info
        duration = round(float(getattr(info, "length", 0.0) or 0.0))
        bitrate = int(round(float(getattr(info, "bitrate", 0) or 0) / 1000.0))
        sample_rate = int(getattr(info, "sample_rate", 44100) or 44100)
        bit_depth_raw = getattr(info, "bits_per_sample", None)
        bit_depth = int(bit_depth_raw) if bit_depth_raw and int(bit_depth_raw) > 0 else None

        cls_name = type(mf).__name__.lower()
        if ext == ".flac" or "flac" in cls_name:
            mapped_codec = "flac"
        elif ext == ".mp3" or "mp3" in cls_name:
            mapped_codec = "mp3"
        elif ext == ".opus" or "opus" in cls_name:
            mapped_codec = "opus"
        elif ext in (".ogg", ".oga") or "vorbis" in cls_name:
            mapped_codec = "vorbis"
        elif ext in (".aiff", ".aif") or "aiff" in cls_name:
            mapped_codec = "aiff"
        elif ext == ".wma" or "asf" in cls_name:
            mapped_codec = "wma"
        elif ext == ".wav" or "wave" in cls_name:
            mapped_codec = "pcm_s24le" if (bit_depth or 16) >= 24 else "pcm_s16le"
        elif ext == ".alac":
            mapped_codec = "alac"
        else:
            mapped_codec = map_ffprobe_codec(cls_name, ext, bit_depth)

        tags_lower: Dict[str, str] = {}
        if mf.tags:
            for key in (
                "artist",
                "albumartist",
                "title",
                "album",
                "date",
                "tracknumber",
                "genre",
                "isrc",
                "compilation",
                "bpm",
                "initialkey",
                "musicbrainz_trackid",
                "musicbrainz_artistid",
                "acoustid_id",
            ):
                val = mf.tags.get(key)
                if val:
                    tags_lower[key] = str(val[0]).strip()

        has_cover = bool(getattr(mf, "pictures", None))
        probed = {
            "kind": "audio",
            "codec": mapped_codec,
            "bitrate_kbps": bitrate,
            "sample_rate_hz": sample_rate,
            "bit_depth": bit_depth,
            "duration_sec": duration,
            "tags": tags_lower,
        }
        return probed, {"tags": tags_lower, "has_cover": has_cover}
    except Exception:
        probed = probe_media_file(path)
        if probed.get("kind") != "audio":
            return probed, {"tags": {}, "has_cover": False}
        meta = read_tags_from_file(path, probed.get("tags") or {})
        return probed, meta
    finally:
        if mf is not None:
            del mf


def scan_music_directory(
    progress_cb: Optional[Callable[[int, int, str], None]] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    tracks: List[Dict[str, Any]] = []
    companions: List[Dict[str, Any]] = []
    leftovers: List[Dict[str, Any]] = []

    if not _path_exists_safe(MUSIC_DIR):
        return tracks, companions, leftovers

    # Schritt 1: Schnelle Dateiliste sammeln (ohne Dateien zu oeffnen) fuer exakten Fortschritt
    file_entries: List[Tuple[Path, str]] = []
    for root, dirnames, filenames in os.walk(MUSIC_DIR):
        dirnames[:] = [
            d for d in sorted(dirnames) if not d.startswith(".") and d not in IGNORED_DIR_NAMES
        ]
        root_path = Path(root)
        for fname in sorted(filenames):
            if fname.startswith("."):
                continue
            file_entries.append((root_path / fname, fname))

    total_files = len(file_entries)
    print(f"[TonArchiv] Starte Dateiscan in {MUSIC_DIR} ({total_files} Dateien gefunden) ...", flush=True)
    if progress_cb:
        progress_cb(0, total_files, f"Scanne {total_files} Dateien in {MUSIC_DIR} ...")

    for idx, (full_path, fname) in enumerate(file_entries, start=1):
        try:
            rel_path = full_path.relative_to(MUSIC_DIR).as_posix()
            stat = full_path.stat()
        except OSError:
            continue

        ext = full_path.suffix.lower()
        source_dir = str(Path(rel_path).parent.as_posix())
        if source_dir == ".":
            source_dir = ""
        stable_id = hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:12]

        if ext in VIDEO_EXTS:
            leftovers.append(
                {
                    "id": f"vid-{stable_id}",
                    "sourceRelativePath": rel_path,
                    "sourceDir": source_dir,
                    "fileName": fname,
                    "kind": "video",
                    "reason": "Videodatei — wird niemals angefasst.",
                    "sizeBytes": stat.st_size,
                }
            )
        elif ext in COMPANION_EXTS:
            companions.append(
                {
                    "id": f"comp-{stable_id}",
                    "sourceRelativePath": rel_path,
                    "sourceDir": source_dir,
                    "fileName": fname,
                    "extension": ext,
                    "sizeBytes": stat.st_size,
                    "albumKey": source_dir or fname,
                    "targetPath": None,
                    "moved": False,
                }
            )
        elif ext not in AUDIO_EXTS:
            leftovers.append(
                {
                    "id": f"left-{stable_id}",
                    "sourceRelativePath": rel_path,
                    "sourceDir": source_dir,
                    "fileName": fname,
                    "kind": "other",
                    "reason": "Keine Audio- oder Begleitdatei — Quellordner bleibt deshalb erhalten.",
                    "sizeBytes": stat.st_size,
                }
            )
        else:
            probed, meta = inspect_audio_fast(full_path)
            if probed.get("kind") == "video":
                leftovers.append(
                    {
                        "id": f"vid-{stable_id}",
                        "sourceRelativePath": rel_path,
                        "sourceDir": source_dir,
                        "fileName": fname,
                        "kind": "video",
                        "reason": "Echte MP4-Videodatei (Videostream via ffprobe erkannt) — wird niemals angefasst.",
                        "sizeBytes": stat.st_size,
                    }
                )
            elif probed.get("kind") != "audio":
                leftovers.append(
                    {
                        "id": f"left-{stable_id}",
                        "sourceRelativePath": rel_path,
                        "sourceDir": source_dir,
                        "fileName": fname,
                        "kind": "other",
                        "reason": "Datei konnte nicht als gueltige Audiodatei gelesen werden — bleibt unveraendert.",
                        "sizeBytes": stat.st_size,
                    }
                )
            else:
                t = meta["tags"]
                has_cover = bool(meta["has_cover"])

                raw_artist = t.get("artist") or "Unbekannter Kuenstler"
                raw_album_artist = t.get("albumartist") or t.get("album_artist") or raw_artist
                raw_title = t.get("title") or full_path.stem
                raw_album = t.get("album") or ""
                raw_year = (t.get("date") or t.get("year") or "")[:4]
                raw_track_num = t.get("tracknumber") or t.get("track") or ""
                raw_track = raw_track_num.split("/")[0].zfill(2) if raw_track_num else ""
                raw_genre = t.get("genre") or ""
                raw_key = t.get("initialkey") or t.get("key") or ""
                bpm_str = t.get("bpm") or t.get("tbpm") or ""
                raw_bpm = int(round(float(bpm_str))) if bpm_str.replace(".", "", 1).isdigit() else None
                is_comp = t.get("compilation", "").lower() in ("1", "true", "yes")
                mtime_iso = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()

                tracks.append(
                    {
                        "id": f"trk-{stable_id}",
                        "sourceRelativePath": rel_path,
                        "sourceDir": source_dir,
                        "fileName": fname,
                        "extension": ext,
                        "codec": probed["codec"],
                        "sizeBytes": stat.st_size,
                        "mtimeIso": mtime_iso,
                        "durationSec": probed["duration_sec"],
                        "bitrateKbps": probed["bitrate_kbps"],
                        "sampleRateHz": probed["sample_rate_hz"],
                        "bitDepth": probed["bit_depth"],
                        "spectralCutoffKhz": None,
                        "spectralWarningOnly": False,
                        "originalTags": {
                            "artist": t.get("artist", ""),
                            "albumArtist": t.get("albumartist") or t.get("album_artist") or "",
                            "title": t.get("title", ""),
                            "album": raw_album,
                            "year": raw_year,
                            "trackNumber": raw_track,
                            "genre": raw_genre,
                            "key": raw_key,
                            "bpm": raw_bpm,
                            "compilation": is_comp,
                        },
                        "albumArtist": raw_album_artist,
                        "artist": raw_artist,
                        "title": raw_title,
                        "album": raw_album,
                        "year": raw_year,
                        "trackNumber": raw_track,
                        "genre": raw_genre,
                        "isrc": t.get("isrc", ""),
                        "compilationFlag": is_comp,
                        "mbRecordingId": t.get("musicbrainz_trackid")
                        or t.get("musicbrainz_recordingid")
                        or None,
                        "mbArtistId": t.get("musicbrainz_artistid") or None,
                        "acoustidId": t.get("acoustid_id") or None,
                        "acoustidConfidence": 0.94
                        if (t.get("musicbrainz_trackid") or t.get("musicbrainz_recordingid"))
                        else 0.0,
                        "activeSource": "musicbrainz",
                        "sourceCandidates": [],
                        "cachedLookup": False,
                        "matchedRelease": None,
                        "availableReleases": [],
                        "inMatchedReleaseTracklist": False,
                        "matchedReleaseTrackPos": int(raw_track) if raw_track.isdigit() else None,
                        "isRemixAlbumTrack": False,
                        "detachedFromAlbum": False,
                        "detachReason": None,
                        "musicalKey": raw_key or "—",
                        "camelotKey": raw_key or "—",
                        "bpm": raw_bpm,
                        "replayGainDb": None,
                        "cover": {
                            "status": "existing" if has_cover else "missing",
                            "source": "Eingebettet" if has_cover else "Keine",
                            "resolution": "Eingebettet" if has_cover else "—",
                            "sizeKb": 0,
                            "embeddedBefore": has_cover,
                            "fallbackGradient": "from-slate-800 to-slate-900",
                        },
                        "lyrics": {
                            "status": "missing",
                            "source": "Keine",
                            "syncedLrc": "",
                            "plainText": "",
                        },
                        "isLooseFile": not raw_album and not source_dir,
                        "manualAssignment": "none",
                        "manualReleaseId": None,
                        "pendingReRunTagAndMove": False,
                        "status": "pending",
                        "taggedAt": None,
                        "movedToPath": None,
                        "skippedInMode2Reason": None,
                    }
                )

        if idx % 25 == 0 or idx == total_files:
            if progress_cb:
                progress_cb(idx, total_files, f"Scanne ({idx}/{total_files}): {fname}")
            # GIL kurz freigeben, damit Web-UI & /api/health jederzeit sofort antworten
            time.sleep(0.002)
        if idx % 100 == 0 or idx == total_files:
            print(
                f"[TonArchiv] Scan: {idx}/{total_files} Dateien ({len(tracks)} Audio, {len(companions)} Begleit, {len(leftovers)} ignoriert)",
                flush=True,
            )
        if idx % 200 == 0:
            gc.collect()

    gc.collect()
    return tracks, companions, leftovers


# ---------------------------------------------------------------------------
# 5. Live-Erkennung (AcoustID + MusicBrainz + Discogs + Cover Art + LRCLIB)
# ---------------------------------------------------------------------------
def _compute_fpcalc(path: Path) -> Optional[Tuple[int, str]]:
    try:
        res = subprocess.run(
            ["fpcalc", "-json", str(path)],
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
        if res.returncode != 0:
            return None
        parsed = json.loads(res.stdout or "{}")
        dur = int(round(float(parsed.get("duration") or 0)))
        fp = str(parsed.get("fingerprint") or "").strip()
        return (dur, fp) if dur > 0 and fp else None
    except Exception:
        return None


def _http_get_json(url: str, headers: Dict[str, str], timeout: int = 12) -> Optional[Dict[str, Any]]:
    for attempt in range(3):
        try:
            resp = _HTTP_SESSION.get(url, headers=headers, timeout=timeout)
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code in (429, 503) and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            return None
        except Exception:
            if attempt < 2:
                time.sleep(0.6 * (attempt + 1))
                continue
            return None
    return None


_AUDIOBOOK_SEC_TYPES = {"audiobook", "audio drama", "spokenword", "interview", "broadcast"}
_AUDIOBOOK_TITLE_RE = re.compile(
    r"\b(hoerspiel|hörspiel|audiobook|folge\s*\d+|kapitel\s*\d+|teil\s*\d+|geschichten|kinderlieder|pj\s*masks|benjamin\s*bluemchen|bibi\s*blocksberg|die\s*drei\s*\?{3})\b",
    re.IGNORECASE,
)
_FEAT_SPLIT_RE = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|with|x)\s+", re.IGNORECASE)
_QUERY_CLEAN_PARENS_RE = re.compile(
    r"\s*[\(\[](?:remaster(?:ed)?(?:\s+\d{4})?|deluxe(?:\s+edition)?|explicit|clean|official\s+(?:video|audio|lyric\s+video)|hd|hq|feat\.?[^\)\]]*|ft\.?[^\)\]]*|radio\s+version|album\s+version|bonus\s+track)[\)\]]",
    re.IGNORECASE,
)


def _norm_cmp(text: str) -> str:
    raw = unicodedata.normalize("NFKD", str(text or ""))
    stripped = "".join(ch for ch in raw if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", stripped.lower()).strip()


def _clean_query_artist(artist: str) -> str:
    a = str(artist or "").strip()
    if not a:
        return ""
    a = _FEAT_SPLIT_RE.split(a, maxsplit=1)[0].strip()
    if "," in a:
        a = a.split(",", 1)[0].strip()
    if " & " in a and len(a.split(" & ")[0].strip()) >= 3:
        # Fuer sekundäre Suchanfrage (z. B. "Alan Walker & Ava Max" -> "Alan Walker")
        return a.split(" & ", 1)[0].strip()
    return a


def _clean_query_title(title: str) -> str:
    t = str(title or "").strip()
    if not t:
        return ""
    t = _QUERY_CLEAN_PARENS_RE.sub("", t).strip()
    t = re.sub(r"\s{2,}", " ", t).strip(" -_")
    return t or str(title or "").strip()


def _token_similarity(a: str, b: str) -> float:
    na = _norm_cmp(a)
    nb = _norm_cmp(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    seq = difflib.SequenceMatcher(None, na, nb).ratio()
    ta = set(na.split())
    tb = set(nb.split())
    jaccard = len(ta & tb) / max(1, len(ta | tb))
    # Contained primary artist bonus (e.g. "Alan Walker" in "Alan Walker & Ava Max")
    contain_bonus = 0.0
    if len(na) >= 4 and (na in nb or nb in na):
        contain_bonus = 0.15
    return min(1.0, max(seq, 0.55 * seq + 0.45 * jaccard) + contain_bonus)


def _is_unknown_artist(artist: str) -> bool:
    n = _norm_cmp(artist)
    return (
        not n
        or n in ("unbekannt", "unknown", "unknown artist", "unbekannter kuenstler", "unbekannter kunstler", "various", "va")
    )


def _is_audiobook_or_spokenword(
    sec_types: List[str],
    cand_artist: str,
    cand_title: str,
    cand_album: str,
    orig_artist: str,
    orig_album: str,
) -> bool:
    orig_blob = f"{orig_artist} {orig_album}"
    # Wenn die Originaldatei selbst schon als Hoerspiel/Audiobook getaggt ist, nicht blockieren
    if _AUDIOBOOK_TITLE_RE.search(orig_blob):
        return False
    sec_low = {s.lower() for s in (sec_types or [])}
    if sec_low & _AUDIOBOOK_SEC_TYPES:
        return True
    cand_blob = f"{cand_artist} {cand_title} {cand_album}"
    if _AUDIOBOOK_TITLE_RE.search(cand_blob):
        # Nur ablehnen, wenn Kuenstler nicht wirklich uebereinstimmt
        if _token_similarity(orig_artist, cand_artist) < 0.70:
            return True
    return False


def _score_text_candidate(
    orig_artist: str,
    orig_title: str,
    orig_duration: int,
    cand_artist: str,
    cand_title: str,
    cand_duration: int,
    base_score: float,
    sec_types: Optional[List[str]] = None,
    cand_album: str = "",
    orig_album: str = "",
) -> float:
    """Kalibrierte Verifikation fuer Text-Treffer (MusicBrainz / Discogs / Deezer).
    Verhindert Fehl-Tags (z. B. Hoerspiele wie PJ Masks oder falscher Interpret)."""
    if _is_audiobook_or_spokenword(
        sec_types or [], cand_artist, cand_title, cand_album, orig_artist, orig_album
    ):
        return 0.0

    title_sim = max(
        _token_similarity(orig_title, cand_title),
        _token_similarity(_clean_query_title(orig_title), _clean_query_title(cand_title)),
    )
    if title_sim < 0.50:
        return 0.0

    unknown_artist = _is_unknown_artist(orig_artist)
    if unknown_artist:
        # Ohne bekannten Kuenstler darf eine reine Textsuche NIEMALS >= 0.80 erreichen —
        # fuer unbekannte/kaputte Tags ist zwingend eine echte Musik-ID (AcoustID/ShazamIO) noetig!
        artist_sim = 0.55
    else:
        artist_sim = max(
            _token_similarity(orig_artist, cand_artist),
            _token_similarity(_clean_query_artist(orig_artist), _clean_query_artist(cand_artist)),
        )
        if artist_sim < 0.45:
            return 0.0

    dur_adj = 0.0
    if orig_duration > 0 and cand_duration > 0:
        diff = abs(orig_duration - cand_duration)
        if diff > 45:
            return 0.0
        elif diff > 25:
            dur_adj = -0.25
        elif diff > 15:
            dur_adj = -0.10
        elif diff <= 5:
            dur_adj = 0.05

    combined = (0.45 * title_sim + 0.40 * artist_sim + 0.15 * min(1.0, max(0.0, base_score))) + dur_adj
    if unknown_artist:
        combined = min(combined, 0.60)
    return round(max(0.0, min(0.98, combined)), 2)


def _pick_best_mb_releases(
    raw_releases: List[Dict[str, Any]],
    track_album: str,
    mb_artist: str,
    track_year: str,
    track_pos: int,
    mb_title: str,
    track_dur: int,
    base_score: float,
    orig_artist: str = "",
) -> List[Dict[str, Any]]:
    """Bewertet alle MusicBrainz-Releases statt blind releases[0] zu nehmen."""
    expect_comp = bool(
        re.search(r"\b(hits|sampler|various|best of|compilation|charts|bravo|now that)\b", track_album or "", re.IGNORECASE)
    )
    scored: List[Tuple[float, Dict[str, Any]]] = []
    seen_ids = set()

    for rel in raw_releases or []:
        rel_id = str(rel.get("id") or "").strip()
        if not rel_id or rel_id in seen_ids:
            continue
        seen_ids.add(rel_id)
        rel_title = str(rel.get("title") or track_album or "").strip()
        rg = rel.get("release-group") or {}
        primary_type = str(rg.get("primary-type") or "").lower()
        sec_types = [str(s).lower() for s in (rg.get("secondary-types") or [])]

        if _is_audiobook_or_spokenword(sec_types, mb_artist, mb_title, rel_title, orig_artist or mb_artist, track_album):
            continue

        status = str(rel.get("status") or "").lower()
        is_comp = "compilation" in sec_types or primary_type == "compilation"
        is_remix = "remix" in sec_types or "remix" in rel_title.lower()
        rel_date = str(rel.get("date") or "")[:4]

        rank = base_score
        if status == "official":
            rank += 0.10
        elif status in ("bootleg", "pseudo-release"):
            rank -= 0.25

        if track_album:
            alb_sim = _token_similarity(track_album, rel_title)
            if alb_sim >= 0.80:
                rank += 0.30
            elif alb_sim >= 0.55:
                rank += 0.14

        if not expect_comp:
            if primary_type == "album" and not is_comp:
                rank += 0.14
            elif primary_type in ("single", "ep"):
                rank += 0.05
            elif is_comp:
                rank -= 0.18
        else:
            if is_comp:
                rank += 0.14

        if rel_date:
            rank += 0.03

        # Track-Position aus Media/Tracks extrahieren, falls MusicBrainz sie mitliefert
        pos_found = track_pos
        track_count = int(rel.get("track-count") or 0)
        for media in rel.get("media") or []:
            if not track_count and media.get("track-count"):
                track_count = int(media.get("track-count") or 0)
            for mtrk in media.get("track") or []:
                mnum = str(mtrk.get("number") or "").strip()
                if mnum.isdigit():
                    pos_found = int(mnum)
                    break

        rel_obj = {
            "releaseId": rel_id,
            "title": rel_title or track_album,
            "albumArtist": "Various Artists" if is_comp else mb_artist,
            "year": rel_date or track_year or "",
            "country": rel.get("country") or "XW",
            "format": (
                ((rel.get("media") or [{}])[0].get("format") if rel.get("media") else None)
                or "Digital Media"
            ),
            "trackCount": max(1, track_count),
            "isCompilation": is_comp,
            "isRemixAlbum": is_remix,
            "matchScore": round(min(0.99, max(0.50, base_score)), 2),
            "tracklist": [
                {
                    "position": max(1, pos_found),
                    "title": mb_title,
                    "durationSec": int(track_dur or 0),
                }
            ],
        }
        scored.append((rank, rel_obj))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [item[1] for item in scored[:5]]


def _pick_best_acoustid_recording(
    recordings: List[Dict[str, Any]],
    file_duration: int,
    hint_artist: str = "",
    hint_title: str = "",
) -> Optional[Dict[str, Any]]:
    """Waehlt aus allen AcoustID-Recordings den saubersten Treffer (Dauer + Release-Qualitaet)."""
    best_rec: Optional[Dict[str, Any]] = None
    best_rank = -999.0
    for rec in recordings or []:
        rec_title = str(rec.get("title") or "").strip()
        rec_artists = rec.get("artists") or []
        rec_artist = str(rec_artists[0].get("name") or "").strip() if rec_artists else ""
        if not rec_title and not rec_artist:
            continue
        rgs = rec.get("releasegroups") or []
        sec_all: List[str] = []
        has_album_rg = False
        for rg in rgs:
            sec = [str(s).lower() for s in (rg.get("secondarytypes") or [])]
            sec_all.extend(sec)
            if str(rg.get("type") or "").lower() == "album" and "compilation" not in sec:
                has_album_rg = True
        if _is_audiobook_or_spokenword(sec_all, rec_artist, rec_title, "", hint_artist, ""):
            continue

        rank = 0.0
        rec_dur = int(round(float(rec.get("duration") or 0)))
        if file_duration > 0 and rec_dur > 0:
            diff = abs(file_duration - rec_dur)
            if diff <= 5:
                rank += 3.0
            elif diff <= 15:
                rank += 1.5
            elif diff > 40:
                rank -= 4.0
        if has_album_rg:
            rank += 2.0
        rank += min(2.0, len(rgs) * 0.25)
        if hint_artist and not _is_unknown_artist(hint_artist):
            rank += _token_similarity(hint_artist, rec_artist) * 1.2
        if hint_title:
            rank += _token_similarity(hint_title, rec_title) * 1.0
        if rank > best_rank:
            best_rank = rank
            best_rec = rec
    return best_rec


async def _recognize_with_shazam(full_path: Path) -> Optional[Dict[str, Any]]:
    """Erkennt einen Song direkt ueber die Audio-Wellenform per ShazamIO (ohne API-Key)."""
    if not SHAZAMIO_AVAILABLE or _ShazamClient is None or not full_path.exists():
        return None
    await shazam_limiter.acquire()
    try:
        shazam = _ShazamClient()
        rec_fn = getattr(shazam, "recognize", None) or getattr(shazam, "recognize_song", None)
        if rec_fn is None:
            return None
        out = await asyncio.wait_for(rec_fn(str(full_path)), timeout=25)
        if not isinstance(out, dict):
            return None
        trk = out.get("track")
        if not isinstance(trk, dict):
            return None
        sh_title = str(trk.get("title") or "").strip()
        sh_artist = str(trk.get("subtitle") or "").strip()
        if not sh_title or not sh_artist:
            return None
        sh_isrc = str(trk.get("isrc") or "").strip()
        sh_genre = str((trk.get("genres") or {}).get("primary") or "").strip()
        images = trk.get("images") or {}
        sh_cover = str(images.get("coverarthq") or images.get("coverart") or "").strip()
        sh_album = ""
        sh_year = ""
        for sec in trk.get("sections") or []:
            if not isinstance(sec, dict):
                continue
            for meta in sec.get("metadata") or []:
                if not isinstance(meta, dict):
                    continue
                mtitle = str(meta.get("title") or "").lower()
                mtext = str(meta.get("text") or "").strip()
                if mtitle == "album" and mtext and not sh_album:
                    sh_album = mtext
                elif mtitle == "released" and mtext and not sh_year:
                    m_yr = re.search(r"(19|20)\d{2}", mtext)
                    if m_yr:
                        sh_year = m_yr.group(0)
        return {
            "artist": sh_artist,
            "title": sh_title,
            "album": sh_album,
            "year": sh_year,
            "genre": sh_genre,
            "isrc": sh_isrc,
            "coverUrl": sh_cover,
            "shazamKey": str(trk.get("key") or ""),
        }
    except Exception:
        return None


async def _fetch_mb_recording_by_id(mb_recording_id: str) -> Optional[Dict[str, Any]]:
    cached = cache_get("mb_rec_id", mb_recording_id)
    if cached is not None:
        return cached
    await mb_limiter.acquire()
    url = f"https://musicbrainz.org/ws/2/recording/{quote(mb_recording_id)}?inc=artists+releases+release-groups+isrcs+media&fmt=json"
    data = await asyncio.to_thread(
        _http_get_json, url, {"User-Agent": MB_USER_AGENT, "Accept": "application/json"}
    )
    if data and data.get("id"):
        cache_put("mb_rec_id", mb_recording_id, data)
    return data


async def lookup_track_metadata(
    track: Dict[str, Any],
    cfg: Dict[str, Any],
    force_refresh: bool = False,
    use_audio_id: bool = False,
) -> Tuple[Dict[str, Any], bool, Optional[str]]:
    """Fuehrt gecachte, rate-limitierte Live-Abfragen fuer einen Track aus (Read-Only).
    Mit use_audio_id=True wird die Audio-Wellenform (AcoustID / ShazamIO) priorisiert,
    um auch falsch getaggte Dateien (z. B. falsche Hoerspiel-Tags) sicher zu reparieren."""
    artist = (track.get("artist") or "").strip()
    title = (track.get("title") or "").strip()
    album = (track.get("album") or "").strip()
    duration_sec_track = int(track.get("durationSec") or 0)
    raw_pos = track.get("matchedReleaseTrackPos")
    track_pos = int(raw_pos) if isinstance(raw_pos, int) and raw_pos > 0 else 1

    cache_hit = False
    candidates: List[Dict[str, Any]] = []
    available_releases: List[Dict[str, Any]] = []
    matched_release: Optional[Dict[str, Any]] = None
    acoustid_fallback_release: Optional[Dict[str, Any]] = None
    fallback_cover_url: Optional[str] = None
    fallback_cover_source: str = "Cover Art Archive"
    active_source: str = str(track.get("activeSource") or "musicbrainz")
    mb_recording_id = None if use_audio_id else track.get("mbRecordingId")
    mb_artist_id = None if use_audio_id else track.get("mbArtistId")
    acoustid_id = track.get("acoustidId")
    confidence = 0.0 if use_audio_id else float(track.get("acoustidConfidence") or 0.0)
    threshold = float(cfg.get("confidenceThreshold", CONFIDENCE_THRESHOLD))
    err_msg: Optional[str] = None
    audio_id_verified = False
    verified_artist = artist
    verified_title = title
    verified_album = album
    verified_year = str(track.get("year") or "")
    verified_genre = str(track.get("genre") or "")
    verified_isrc = str(track.get("isrc") or "")

    full_path = safe_resolve_under_music(track["sourceRelativePath"])

    # 5a-1. AcoustID Chromaprint Audio-Fingerprint (echte Wellenform-Erkennung via fpcalc)
    if ACOUSTID_API_KEY and (use_audio_id or not acoustid_id or force_refresh):
        fp_cache_key = hashlib.sha1(
            f"{track['sourceRelativePath']}|{track.get('sizeBytes', 0)}".encode("utf-8")
        ).hexdigest()
        fp_cached = None if force_refresh else cache_get("fingerprint", fp_cache_key)
        if fp_cached is not None:
            cache_hit = True
            acoustid_id = fp_cached.get("acoustidId")
            if fp_cached.get("mbRecordingId"):
                mb_recording_id = fp_cached["mbRecordingId"]
            if fp_cached.get("score"):
                sc = float(fp_cached["score"])
                if sc >= threshold:
                    confidence = max(confidence, sc)
                    audio_id_verified = True
            if isinstance(fp_cached.get("release"), dict):
                acoustid_fallback_release = fp_cached["release"]
            if fp_cached.get("artist") and fp_cached.get("title"):
                verified_artist = fp_cached["artist"]
                verified_title = fp_cached["title"]
                if fp_cached.get("album"):
                    verified_album = fp_cached["album"]
                candidates.append(
                    {
                        "provider": "musicbrainz",
                        "artist": verified_artist,
                        "albumArtist": (
                            acoustid_fallback_release["albumArtist"]
                            if acoustid_fallback_release
                            else verified_artist
                        ),
                        "title": verified_title,
                        "album": verified_album,
                        "year": verified_year,
                        "confidence": round(float(fp_cached.get("score") or 0.0), 2),
                        "mbRecordingId": mb_recording_id,
                        "notes": "Chromaprint Audio-Fingerprint via AcoustID (Cache)",
                    }
                )
        elif full_path.exists():
            fp_res = await asyncio.to_thread(_compute_fpcalc, full_path)
            if fp_res:
                duration_sec, fingerprint = fp_res
                await acoustid_limiter.acquire()
                url = (
                    f"https://api.acoustid.org/v2/lookup?client={quote(ACOUSTID_API_KEY)}"
                    f"&meta=recordings+releasegroups+compress&duration={duration_sec}&fingerprint={quote(fingerprint)}"
                )
                ac_data = await asyncio.to_thread(
                    _http_get_json, url, {"User-Agent": MB_USER_AGENT}
                )
                if ac_data and ac_data.get("results"):
                    best = max(ac_data["results"], key=lambda r: float(r.get("score") or 0.0))
                    acoustid_id = best.get("id")
                    score = round(float(best.get("score") or 0.0), 2)
                    rec0 = _pick_best_acoustid_recording(
                        best.get("recordings") or [],
                        duration_sec_track or duration_sec,
                        "" if use_audio_id else artist,
                        "" if use_audio_id else title,
                    )
                    rec_id = rec0.get("id") if rec0 else None
                    if rec_id:
                        mb_recording_id = rec_id
                    if score >= threshold and rec0:
                        confidence = max(confidence, score)
                        audio_id_verified = True
                    if rec0:
                        rec_artist = ((rec0.get("artists") or [{}])[0].get("name") or artist).strip()
                        rec_title = (rec0.get("title") or title).strip()
                        rgs = rec0.get("releasegroups") or []
                        # Studio-Album gegenueber Compilation bevorzugen
                        rgs_sorted = sorted(
                            rgs,
                            key=lambda g: (
                                0 if str(g.get("type") or "").lower() == "album" and "compilation" not in [s.lower() for s in (g.get("secondarytypes") or [])] else 1
                            ),
                        )
                        rg_album = album
                        if rgs_sorted:
                            rg0 = rgs_sorted[0]
                            rg_album = rg0.get("title") or album
                            rg_sec = [s.lower() for s in (rg0.get("secondarytypes") or [])]
                            rg_is_comp = "compilation" in rg_sec
                            acoustid_fallback_release = {
                                "releaseId": f"acoustid-{rg0.get('id') or rec_id or 'rg'}",
                                "title": rg_album,
                                "albumArtist": "Various Artists" if rg_is_comp else rec_artist,
                                "year": verified_year,
                                "country": "XW",
                                "format": "Digital Media",
                                "trackCount": 1,
                                "isCompilation": rg_is_comp,
                                "isRemixAlbum": "remix" in rg_sec or "remix" in rg_album.lower(),
                                "matchScore": score,
                                "tracklist": [
                                    {
                                        "position": track_pos,
                                        "title": rec_title,
                                        "durationSec": duration_sec_track or duration_sec,
                                    }
                                ],
                            }
                        if score >= threshold:
                            verified_artist = rec_artist
                            verified_title = rec_title
                            if rg_album:
                                verified_album = rg_album
                        candidates.append(
                            {
                                "provider": "musicbrainz",
                                "artist": rec_artist,
                                "albumArtist": (
                                    acoustid_fallback_release["albumArtist"]
                                    if acoustid_fallback_release
                                    else rec_artist
                                ),
                                "title": rec_title,
                                "album": rg_album,
                                "year": verified_year,
                                "confidence": score,
                                "mbRecordingId": rec_id,
                                "notes": "Chromaprint Audio-Fingerprint via AcoustID",
                            }
                        )
                        cache_put(
                            "fingerprint",
                            fp_cache_key,
                            {
                                "acoustidId": acoustid_id,
                                "mbRecordingId": mb_recording_id,
                                "score": score,
                                "artist": rec_artist,
                                "title": rec_title,
                                "album": rg_album,
                                "release": acoustid_fallback_release,
                            },
                        )

    # 5a-2. ShazamIO Audio-Fingerprint (funktioniert ohne API-Key direkt auf der Audiodatei!)
    should_run_shazam = (
        SHAZAMIO_AVAILABLE
        and bool(cfg.get("enableShazamFallback", True))
        and not audio_id_verified
        and full_path.exists()
        and (use_audio_id or _is_unknown_artist(artist) or confidence < threshold)
    )
    if should_run_shazam:
        sh_key = hashlib.sha1(
            f"shazam|{track['sourceRelativePath']}|{track.get('sizeBytes', 0)}".encode("utf-8")
        ).hexdigest()
        sh_data = None if force_refresh else cache_get("shazam", sh_key)
        if sh_data is not None:
            cache_hit = True
        else:
            sh_data = await _recognize_with_shazam(full_path)
            cache_put("shazam", sh_key, sh_data or {})

        if sh_data and sh_data.get("artist") and sh_data.get("title"):
            sh_artist = str(sh_data["artist"]).strip()
            sh_title = str(sh_data["title"]).strip()
            sh_album = str(sh_data.get("album") or "").strip()
            sh_year = str(sh_data.get("year") or "").strip()
            sh_genre = str(sh_data.get("genre") or "").strip()
            sh_isrc = str(sh_data.get("isrc") or "").strip()
            sh_cov = str(sh_data.get("coverUrl") or "").strip()
            if sh_cov and not fallback_cover_url:
                fallback_cover_url = sh_cov
                fallback_cover_source = "ShazamIO"
            sh_conf = 0.94
            audio_id_verified = True
            confidence = max(confidence, sh_conf)
            verified_artist = sh_artist
            verified_title = sh_title
            if sh_album:
                verified_album = sh_album
            if sh_year:
                verified_year = sh_year
            if sh_genre:
                verified_genre = sh_genre
            if sh_isrc:
                verified_isrc = sh_isrc
            sh_rel = {
                "releaseId": f"shazam-{sh_data.get('shazamKey') or hashlib.sha1(f'{sh_artist}|{sh_album or sh_title}'.encode('utf-8')).hexdigest()[:10]}",
                "title": sh_album or sh_title,
                "albumArtist": sh_artist,
                "year": sh_year or verified_year,
                "country": "XW",
                "format": "Digital Media (ShazamIO Audio-ID)",
                "trackCount": 1,
                "isCompilation": False,
                "isRemixAlbum": "remix" in (sh_album or "").lower(),
                "matchScore": sh_conf,
                "tracklist": [
                    {
                        "position": track_pos,
                        "title": sh_title,
                        "durationSec": duration_sec_track,
                    }
                ],
            }
            available_releases.append(sh_rel)
            matched_release = sh_rel
            active_source = "shazamio"
            candidates.append(
                {
                    "provider": "shazamio",
                    "artist": sh_artist,
                    "albumArtist": sh_artist,
                    "title": sh_title,
                    "album": sh_album or verified_album,
                    "year": sh_year or verified_year,
                    "confidence": sh_conf,
                    "notes": "Echte Audio-Wellenform-Erkennung via ShazamIO (Musik-ID)",
                }
            )

    # 5b. MusicBrainz Lookup:
    # (1) Direkter MBID-Lookup, wenn AcoustID eine exakte Recording-ID geliefert hat
    direct_mb_rec: Optional[Dict[str, Any]] = None
    if mb_recording_id and audio_id_verified:
        direct_mb_rec = await _fetch_mb_recording_by_id(str(mb_recording_id))

    if direct_mb_rec and direct_mb_rec.get("id"):
        ac_list = direct_mb_rec.get("artist-credit") or []
        mb_artist = (
            "".join(
                (item.get("name") or item.get("artist", {}).get("name") or "") + (item.get("joinphrase") or "")
                for item in ac_list
            ).strip()
            or verified_artist
        )
        if ac_list and ac_list[0].get("artist", {}).get("id"):
            mb_artist_id = ac_list[0]["artist"]["id"]
        mb_title = str(direct_mb_rec.get("title") or verified_title).strip()
        isrcs = direct_mb_rec.get("isrcs") or []
        if isrcs and not verified_isrc:
            verified_isrc = str(isrcs[0])
        mb_rels = _pick_best_mb_releases(
            direct_mb_rec.get("releases") or [],
            verified_album,
            mb_artist,
            verified_year,
            track_pos,
            mb_title,
            duration_sec_track,
            max(0.92, confidence),
            orig_artist=mb_artist,
        )
        if mb_rels:
            available_releases = mb_rels + available_releases
            matched_release = mb_rels[0]
            active_source = "musicbrainz"
            candidates.append(
                {
                    "provider": "musicbrainz",
                    "artist": mb_artist,
                    "albumArtist": matched_release["albumArtist"],
                    "title": mb_title,
                    "album": matched_release["title"],
                    "year": matched_release["year"],
                    "confidence": round(max(0.93, confidence), 2),
                    "mbRecordingId": str(direct_mb_rec["id"]),
                    "mbReleaseId": matched_release["releaseId"],
                    "mbArtistId": mb_artist_id,
                    "notes": "MusicBrainz Direkt-Abruf ueber Audio-ID (MBID)",
                }
            )
    else:
        # (2) Mehrstufige, streng verifizierte MusicBrainz-Suche (ISRC -> Strict -> Cleaned Artist+Title)
        search_artist = verified_artist if audio_id_verified else artist
        search_title = verified_title if audio_id_verified else title
        search_album = verified_album if audio_id_verified else album
        cache_key = hashlib.sha1(
            f"v2|{search_artist.lower()}|{search_title.lower()}|{search_album.lower()}|{verified_isrc}|{duration_sec_track}".encode("utf-8")
        ).hexdigest()

        mb_data: Optional[Dict[str, Any]] = None if force_refresh else cache_get("mb_release", cache_key)
        if mb_data is not None:
            cache_hit = True
        elif verified_isrc or (search_title and search_title != "Unbekannt"):
            # Versuch A: ISRC (falls ShazamIO oder Tag eine echte ISRC hat — 100 % exakt!)
            if verified_isrc:
                await mb_limiter.acquire()
                isrc_url = f"https://musicbrainz.org/ws/2/recording?query=isrc:{quote(verified_isrc)}&fmt=json&limit=5"
                mb_data = await asyncio.to_thread(
                    _http_get_json, isrc_url, {"User-Agent": MB_USER_AGENT, "Accept": "application/json"}
                )

            # Versuch B: Streng (Titel + Kuenstler + Album)
            if not (mb_data and mb_data.get("recordings")) and search_title:
                await mb_limiter.acquire()
                q_parts = [f'recording:"{search_title.replace(chr(34), "")}"']
                if not _is_unknown_artist(search_artist):
                    q_parts.append(f'artist:"{search_artist.replace(chr(34), "")}"')
                if search_album:
                    q_parts.append(f'release:"{search_album.replace(chr(34), "")}"')
                mb_url = f"https://musicbrainz.org/ws/2/recording?query={quote(' AND '.join(q_parts))}&fmt=json&limit=8"
                mb_data = await asyncio.to_thread(
                    _http_get_json, mb_url, {"User-Agent": MB_USER_AGENT, "Accept": "application/json"}
                )

            # Versuch C: Bereinigter Fallback ohne starres release:"..." (loest Deluxe-Alben & "Alan Walker & Ava Max"!)
            if (
                not (mb_data and mb_data.get("recordings"))
                and search_title
                and not _is_unknown_artist(search_artist)
            ):
                clean_t = _clean_query_title(search_title)
                clean_a = _clean_query_artist(search_artist)
                if clean_t and clean_a:
                    await mb_limiter.acquire()
                    q_fb = f'recording:"{clean_t.replace(chr(34), "")}" AND artist:"{clean_a.replace(chr(34), "")}"'
                    mb_url_fb = f"https://musicbrainz.org/ws/2/recording?query={quote(q_fb)}&fmt=json&limit=8"
                    mb_fb = await asyncio.to_thread(
                        _http_get_json, mb_url_fb, {"User-Agent": MB_USER_AGENT, "Accept": "application/json"}
                    )
                    if mb_fb is not None:
                        mb_data = mb_fb

            if mb_data is not None:
                cache_put("mb_release", cache_key, mb_data)
            else:
                err_msg = "MusicBrainz nicht erreichbar (übersprungen)."

        if mb_data and mb_data.get("recordings"):
            best_mb: Optional[Tuple[float, Dict[str, Any], str, Optional[str], str, List[Dict[str, Any]]]] = None
            for rec in (mb_data.get("recordings") or [])[:8]:
                ac_list = rec.get("artist-credit") or []
                rec_artist = (
                    "".join(
                        (item.get("name") or item.get("artist", {}).get("name") or "") + (item.get("joinphrase") or "")
                        for item in ac_list
                    ).strip()
                    or search_artist
                )
                rec_artist_id = (
                    ac_list[0].get("artist", {}).get("id") if ac_list else None
                )
                rec_title = str(rec.get("title") or search_title).strip()
                rec_dur = int(round(float(rec.get("length") or 0) / 1000.0))
                raw_mb_score = min(0.99, float(rec.get("score") or 0) / 100.0)

                sec_union: List[str] = []
                for rel in rec.get("releases") or []:
                    rg = rel.get("release-group") or {}
                    sec_union.extend(str(s).lower() for s in (rg.get("secondary-types") or []))

                verified_score = _score_text_candidate(
                    search_artist,
                    search_title,
                    duration_sec_track,
                    rec_artist,
                    rec_title,
                    rec_dur,
                    raw_mb_score,
                    sec_types=sec_union if sec_union and all(s in _AUDIOBOOK_SEC_TYPES for s in sec_union) else [],
                    orig_album=search_album,
                )
                if verified_isrc and raw_mb_score >= 0.90 and verified_score > 0:
                    verified_score = max(verified_score, 0.95)
                if verified_score <= 0.0:
                    continue

                rels = _pick_best_mb_releases(
                    rec.get("releases") or [],
                    search_album,
                    rec_artist,
                    verified_year,
                    track_pos,
                    rec_title,
                    duration_sec_track or rec_dur,
                    verified_score,
                    orig_artist=search_artist,
                )
                if not rels and (rec.get("releases") or []):
                    # Alle Releases dieses Recordings waren Hoerspiele/Audiobooks -> komplett verwerfen!
                    continue
                if best_mb is None or verified_score > best_mb[0] or (
                    abs(verified_score - best_mb[0]) < 0.02 and len(rels) > len(best_mb[5])
                ):
                    best_mb = (verified_score, rec, rec_artist, rec_artist_id, rec_title, rels)

            if best_mb is not None:
                mb_score, top, mb_artist, found_artist_id, mb_title, mb_rels = best_mb
                confidence = max(confidence, mb_score)
                mb_recording_id = top.get("id") or mb_recording_id
                if found_artist_id:
                    mb_artist_id = found_artist_id
                if mb_rels:
                    available_releases = mb_rels + [
                        r for r in available_releases if r["releaseId"] not in {x["releaseId"] for x in mb_rels}
                    ]
                    if not audio_id_verified or mb_score >= threshold:
                        matched_release = mb_rels[0]
                        active_source = "musicbrainz"
                candidates.append(
                    {
                        "provider": "musicbrainz",
                        "artist": mb_artist,
                        "albumArtist": (mb_rels[0]["albumArtist"] if mb_rels else mb_artist),
                        "title": mb_title,
                        "album": (mb_rels[0]["title"] if mb_rels else search_album),
                        "year": (mb_rels[0]["year"] if mb_rels else verified_year),
                        "confidence": mb_score,
                        "mbRecordingId": mb_recording_id,
                        "mbReleaseId": mb_rels[0]["releaseId"] if mb_rels else None,
                        "mbArtistId": mb_artist_id,
                        "notes": "Verifizierter MusicBrainz Release-Treffer",
                    }
                )

    # 5c. Discogs Fallback (streng verifiziert — nie blind results[0]!)
    fallback_artist = verified_artist if audio_id_verified else artist
    fallback_title = verified_title if audio_id_verified else title
    fallback_album = verified_album if audio_id_verified else album
    fb_cache_key = hashlib.sha1(
        f"v2|{fallback_artist.lower()}|{fallback_title.lower()}|{fallback_album.lower()}|{duration_sec_track}".encode("utf-8")
    ).hexdigest()

    if (
        DISCOGS_TOKEN
        and (matched_release is None or confidence < threshold)
        and fallback_title
        and not _is_unknown_artist(fallback_artist)
    ):
        cached_discogs = None if force_refresh else cache_get("discogs", fb_cache_key)
        d_data = cached_discogs
        if d_data is not None:
            cache_hit = True
        else:
            await discogs_limiter.acquire()
            q = f"{_clean_query_artist(fallback_artist)} {_clean_query_title(fallback_title)}".strip()
            d_url = f"https://api.discogs.com/database/search?q={quote(q)}&type=release&per_page=5"
            d_data = await asyncio.to_thread(
                _http_get_json,
                d_url,
                {
                    "User-Agent": MB_USER_AGENT,
                    "Authorization": f"Discogs token={DISCOGS_TOKEN}",
                },
            )
            if d_data is not None:
                cache_put("discogs", fb_cache_key, d_data)

        if d_data and d_data.get("results"):
            best_d: Optional[Tuple[float, Dict[str, Any], str, str, str, str]] = None
            for r_idx, r_item in enumerate((d_data.get("results") or [])[:5]):
                d_title_full = str(r_item.get("title") or "")
                d_artist, d_album = (
                    d_title_full.split(" - ", 1) if " - " in d_title_full else (fallback_artist, d_title_full)
                )
                d_artist = d_artist.strip() or fallback_artist
                d_album = d_album.strip() or fallback_album
                d_score = _score_text_candidate(
                    fallback_artist,
                    fallback_title,
                    duration_sec_track,
                    d_artist,
                    fallback_title,
                    duration_sec_track,
                    0.88,
                    cand_album=d_album,
                    orig_album=fallback_album,
                )
                if d_score < 0.65:
                    continue
                d_year = str(r_item.get("year") or verified_year or "")
                d_formats = [str(f) for f in (r_item.get("format") or [])]
                d_fmt_str = " · ".join(d_formats[:2]) if d_formats else "Digital Media"
                d_is_comp = any("compilation" in f.lower() for f in d_formats) or d_artist.lower() == "various"
                d_rel = {
                    "releaseId": f"discogs-{r_item.get('id') or r_idx}",
                    "title": d_album,
                    "albumArtist": "Various Artists" if d_is_comp else d_artist,
                    "year": d_year,
                    "country": str(r_item.get("country") or "XW"),
                    "format": d_fmt_str,
                    "trackCount": 1,
                    "isCompilation": d_is_comp,
                    "isRemixAlbum": "remix" in d_album.lower(),
                    "matchScore": d_score,
                    "tracklist": [
                        {
                            "position": track_pos,
                            "title": fallback_title,
                            "durationSec": duration_sec_track,
                        }
                    ],
                }
                available_releases.append(d_rel)
                if best_d is None or d_score > best_d[0]:
                    best_d = (d_score, d_rel, d_artist, d_album, d_year, str(r_item.get("cover_image") or ""))
            if best_d is not None:
                d_score, d_rel, d_artist, d_album, d_year, cov_img = best_d
                if cov_img and "spacer.gif" not in cov_img and not fallback_cover_url:
                    fallback_cover_url = cov_img
                    fallback_cover_source = "Discogs"
                candidates.append(
                    {
                        "provider": "discogs",
                        "artist": d_artist,
                        "albumArtist": d_rel["albumArtist"],
                        "title": fallback_title,
                        "album": d_album,
                        "year": d_year,
                        "confidence": d_score,
                        "notes": "Verifizierter Discogs Katalog-Treffer",
                    }
                )
                if matched_release is None and d_score >= threshold:
                    matched_release = d_rel
                    active_source = "discogs"
                confidence = max(confidence, d_score)

    # 5c-2. Deezer Public API Fallback (streng gegen Kuenstler + Titel + Dauer verifiziert!)
    if (
        (matched_release is None or confidence < threshold)
        and fallback_title
        and fallback_title != "Unbekannt"
        and not _is_unknown_artist(fallback_artist)
    ):
        cached_dz = None if force_refresh else cache_get("deezer", fb_cache_key)
        dz_data = cached_dz
        if dz_data is not None:
            cache_hit = True
        else:
            await deezer_limiter.acquire()
            dz_q = f'artist:"{fallback_artist.replace(chr(34), "")}" track:"{fallback_title.replace(chr(34), "")}"'
            dz_url = f"https://api.deezer.com/search?q={quote(dz_q)}&limit=5"
            dz_data = await asyncio.to_thread(
                _http_get_json, dz_url, {"User-Agent": MB_USER_AGENT}
            )
            if not (dz_data and dz_data.get("data")):
                clean_a = _clean_query_artist(fallback_artist)
                clean_t = _clean_query_title(fallback_title)
                if clean_a and clean_t:
                    await deezer_limiter.acquire()
                    dz_url_fb = f"https://api.deezer.com/search?q={quote(f'{clean_a} {clean_t}')}&limit=5"
                    dz_fb = await asyncio.to_thread(
                        _http_get_json, dz_url_fb, {"User-Agent": MB_USER_AGENT}
                    )
                    if dz_fb is not None:
                        dz_data = dz_fb
            if dz_data is not None:
                cache_put("deezer", fb_cache_key, dz_data)

        if dz_data and dz_data.get("data"):
            best_dz: Optional[Tuple[float, Dict[str, Any], str, str, str, str]] = None
            for dz_item in (dz_data.get("data") or [])[:5]:
                dz_artist = str((dz_item.get("artist") or {}).get("name") or "").strip()
                dz_title = str(dz_item.get("title") or "").strip()
                dz_alb = dz_item.get("album") or {}
                dz_album = str(dz_alb.get("title") or fallback_album or "").strip()
                dz_dur = int(dz_item.get("duration") or 0)
                dz_score = _score_text_candidate(
                    fallback_artist,
                    fallback_title,
                    duration_sec_track,
                    dz_artist,
                    dz_title,
                    dz_dur,
                    0.90,
                    cand_album=dz_album,
                    orig_album=fallback_album,
                )
                if dz_score < 0.70:
                    continue
                if fallback_album and _token_similarity(fallback_album, dz_album) >= 0.75:
                    dz_score = min(0.95, round(dz_score + 0.04, 2))
                dz_cov = str(dz_alb.get("cover_xl") or dz_alb.get("cover_big") or dz_alb.get("cover_medium") or "")
                dz_rel = {
                    "releaseId": f"deezer-{dz_alb.get('id') or dz_item.get('id') or '0'}",
                    "title": dz_album,
                    "albumArtist": dz_artist,
                    "year": verified_year,
                    "country": "XW",
                    "format": "Digital Media (Deezer)",
                    "trackCount": 1,
                    "isCompilation": dz_artist.lower() in ("various artists", "various"),
                    "isRemixAlbum": "remix" in dz_album.lower(),
                    "matchScore": dz_score,
                    "tracklist": [
                        {
                            "position": track_pos,
                            "title": dz_title,
                            "durationSec": dz_dur or duration_sec_track,
                        }
                    ],
                }
                if best_dz is None or dz_score > best_dz[0]:
                    best_dz = (dz_score, dz_rel, dz_artist, dz_title, dz_album, dz_cov)

            if best_dz is not None:
                dz_score, dz_rel, dz_artist, dz_title, dz_album, dz_cov = best_dz
                if dz_cov and not fallback_cover_url:
                    fallback_cover_url = dz_cov
                    fallback_cover_source = "Deezer High-Res"
                available_releases.append(dz_rel)
                candidates.append(
                    {
                        "provider": "deezer",
                        "artist": dz_artist,
                        "albumArtist": dz_artist,
                        "title": dz_title,
                        "album": dz_album,
                        "year": verified_year,
                        "confidence": dz_score,
                        "notes": "Verifizierter Deezer Katalog-Treffer",
                    }
                )
                if matched_release is None and dz_score >= threshold:
                    matched_release = dz_rel
                    active_source = "deezer"
                confidence = max(confidence, dz_score)

    # 5c-3. AcoustID Release-Group Fallback, falls AcoustID Treffer hatte aber kein anderer Dienst
    if matched_release is None and acoustid_fallback_release is not None and confidence >= threshold:
        available_releases.append(acoustid_fallback_release)
        matched_release = acoustid_fallback_release
        active_source = "musicbrainz"

    # Wenn MusicBrainz kurz nicht erreichbar war, aber ShazamIO/Discogs/Deezer/AcoustID sauber gerettet hat -> kein Fehler!
    if err_msg and matched_release is not None and confidence >= threshold:
        err_msg = None

    # 5d. Cover Art Check (Cover Art Archive fuer MusicBrainz-UUIDs, sonst ShazamIO/Discogs/Deezer-Cover)
    cover_patch = dict(track.get("cover") or {})
    if cfg.get("embedCover", True):
        rel_id = str(matched_release.get("releaseId") or "") if matched_release else ""
        is_mb_uuid = bool(rel_id) and not rel_id.startswith(("discogs-", "deezer-", "acoustid-", "shazam-"))
        if is_mb_uuid:
            cached_cov = cache_get("cover", rel_id)
            if cached_cov is not None:
                if cached_cov.get("url"):
                    cover_patch = {
                        **cover_patch,
                        "status": "fetched",
                        "source": "Cover Art Archive",
                        "resolution": f"<= {cfg.get('coverMaxSize', 1000)} px",
                        "imageUrl": cached_cov["url"],
                    }
            else:
                caa_url = f"https://coverartarchive.org/release/{rel_id}/front-500"
                try:
                    head_res = await asyncio.to_thread(
                        _HTTP_SESSION.head, caa_url, allow_redirects=True, timeout=8
                    )
                    if head_res.status_code == 200:
                        cache_put("cover", rel_id, {"url": head_res.url})
                        cover_patch = {
                            **cover_patch,
                            "status": "fetched",
                            "source": "Cover Art Archive",
                            "resolution": f"<= {cfg.get('coverMaxSize', 1000)} px",
                            "imageUrl": head_res.url,
                        }
                    else:
                        cache_put("cover", rel_id, {"url": None})
                except Exception:
                    pass

        if (
            fallback_cover_url
            and (use_audio_id or cover_patch.get("status") not in ("fetched", "existing"))
        ):
            cover_patch = {
                **cover_patch,
                "status": "fetched",
                "source": fallback_cover_source,
                "resolution": f"<= {cfg.get('coverMaxSize', 1000)} px",
                "imageUrl": fallback_cover_url,
            }

    best_cand = (
        max(candidates, key=lambda c: float(c.get("confidence") or 0.0))
        if candidates
        else None
    )

    final_artist = (best_cand["artist"] if best_cand and confidence >= threshold and best_cand.get("artist") else artist)
    final_title = (best_cand["title"] if best_cand and confidence >= threshold and best_cand.get("title") else title)
    final_album = (best_cand.get("album") if best_cand and confidence >= threshold and best_cand.get("album") else album)

    # 5e. LRCLIB Synced/Plain Lyrics Lookup (mit dem verifizierten Kuenstler/Titel!)
    lyrics_patch = dict(track.get("lyrics") or {})
    if cfg.get("fetchLyrics", True) and final_title:
        lyr_key = hashlib.sha1(f"{final_artist.lower()}|{final_title.lower()}".encode("utf-8")).hexdigest()
        cached_lyr = None if force_refresh else cache_get("lyrics", lyr_key)
        lyr_data = cached_lyr
        if lyr_data is None:
            lyr_url = f"https://lrclib.net/api/get?artist_name={quote(final_artist)}&track_name={quote(final_title)}"
            if final_album:
                lyr_url += f"&album_name={quote(final_album)}"
            lyr_data = await asyncio.to_thread(
                _http_get_json, lyr_url, {"User-Agent": MB_USER_AGENT}
            )
            cache_put("lyrics", lyr_key, lyr_data or {})

        if lyr_data:
            if lyr_data.get("instrumental"):
                lyrics_patch = {
                    "status": "instrumental",
                    "source": "LRCLIB",
                    "syncedLrc": "",
                    "plainText": "",
                }
            elif lyr_data.get("syncedLyrics"):
                lyrics_patch = {
                    "status": "synced",
                    "source": "LRCLIB",
                    "syncedLrc": lyr_data["syncedLyrics"],
                    "plainText": lyr_data.get("plainLyrics") or "",
                }
            elif lyr_data.get("plainLyrics"):
                lyrics_patch = {
                    "status": "plain",
                    "source": "LRCLIB",
                    "syncedLrc": "",
                    "plainText": lyr_data["plainLyrics"],
                }

    updated = dict(track)
    updated["activeSource"] = active_source
    updated["sourceCandidates"] = candidates
    updated["availableReleases"] = available_releases
    updated["matchedRelease"] = matched_release
    updated["inMatchedReleaseTracklist"] = bool(matched_release)
    updated["mbRecordingId"] = mb_recording_id
    updated["mbArtistId"] = mb_artist_id
    updated["acoustidId"] = acoustid_id
    updated["acoustidConfidence"] = confidence
    updated["cachedLookup"] = cache_hit
    updated["cover"] = cover_patch
    updated["lyrics"] = lyrics_patch
    updated["lookupError"] = err_msg
    updated["status"] = "analyzed" if track.get("status") == "pending" else track.get("status", "analyzed")

    if best_cand and confidence >= threshold:
        changed_core = (
            (best_cand.get("artist") and best_cand["artist"] != updated.get("artist"))
            or (best_cand.get("title") and best_cand["title"] != updated.get("title"))
            or (best_cand.get("album") and best_cand["album"] != updated.get("album"))
            or (
                str(updated.get("sourceRelativePath") or "").startswith("_Review/")
                and matched_release is not None
            )
        )
        updated["artist"] = best_cand["artist"] or updated["artist"]
        updated["albumArtist"] = best_cand["albumArtist"] or updated["albumArtist"]
        updated["title"] = best_cand["title"] or updated["title"]
        if best_cand.get("album"):
            updated["album"] = best_cand["album"]
        if best_cand.get("year"):
            updated["year"] = best_cand["year"]
        if verified_genre and not updated.get("genre"):
            updated["genre"] = verified_genre
        if verified_isrc:
            updated["isrc"] = verified_isrc
        if use_audio_id and changed_core:
            updated["pendingReRunTagAndMove"] = True

    return updated, cache_hit, err_msg


# ---------------------------------------------------------------------------
# 6. Mutagen-Tagging (Modus 2) & Atomares Verschieben (Modus 3)
# ---------------------------------------------------------------------------
def write_tags_to_audio_file(
    full_path: Path,
    track: Dict[str, Any],
    cfg: Dict[str, Any],
    is_dj_remix: bool = False,
    cover_cache: Optional[Dict[str, Optional[Tuple[bytes, str]]]] = None,
) -> Dict[str, Any]:
    """Schreibt Tags via Mutagen. Bei DJ-Remixes bleiben Artist/Titel unveraendert."""
    if MutagenFile is None or not full_path.exists():
        return {"tagged": False, "reason": "Mutagen oder Datei nicht verfuegbar"}

    orig = track.get("originalTags") or {}
    ext = full_path.suffix.lower()
    is_wav = ext == ".wav"

    try:
        easy = MutagenFile(str(full_path), easy=True)
    except Exception as exc:
        return {"tagged": False, "reason": f"Mutagen-Lesefehler ({ext}): {exc}"}
    if easy is None:
        return {"tagged": False, "reason": f"Nicht unterstuetztes Tag-Format ({ext})"}

    if easy.tags is None:
        try:
            easy.add_tags()
        except Exception:
            pass

    def _set_if_allowed(tag_key: str, value: str, allow_overwrite: bool) -> None:
        if not value or easy.tags is None:
            return
        existing = easy.tags.get(tag_key)
        if allow_overwrite or not existing or not str(existing[0]).strip():
            try:
                easy.tags[tag_key] = [value]
            except Exception:
                pass

    if is_dj_remix:
        # DJ-Remix-Regel: Artist & Titel NIE ueberschreiben; nur leere Zusatzfelder ergaenzen
        if cfg.get("enrichRemixEmptyFields", True):
            _set_if_allowed("genre", str(track.get("genre") or ""), False)
            _set_if_allowed("date", str(track.get("year") or ""), False)
    else:
        _set_if_allowed("artist", str(track.get("artist") or orig.get("artist") or ""), True)
        _set_if_allowed(
            "albumartist",
            str(track.get("albumArtist") or track.get("artist") or ""),
            True,
        )
        _set_if_allowed("title", str(track.get("title") or orig.get("title") or ""), True)
        _set_if_allowed("album", str(track.get("album") or ""), True)
        _set_if_allowed("date", str(track.get("year") or ""), True)
        _set_if_allowed("tracknumber", str(track.get("trackNumber") or ""), True)
        _set_if_allowed("genre", str(track.get("genre") or ""), True)

    try:
        easy.save()
    except Exception as exc:
        return {"tagged": False, "reason": f"Mutagen-Speicherfehler ({ext}): {exc}"}

    # Cover Art einbetten (WAV nur wenn WAV_EMBED_MEDIA=true)
    cover = track.get("cover") or {}
    cover_url = cover.get("imageUrl")
    should_embed_cover = (
        cfg.get("embedCover", True)
        and cover_url
        and (not is_wav or cfg.get("wavEmbedMedia", False))
        and (cfg.get("overwriteExistingCover", False) or not cover.get("embeddedBefore"))
    )
    if should_embed_cover:
        try:
            cached_img = cover_cache.get(cover_url) if cover_cache is not None else None
            img_bytes: Optional[bytes] = None
            mime = "image/jpeg"
            if cover_cache is not None and cover_url in cover_cache:
                if cached_img is not None:
                    img_bytes, mime = cached_img
            else:
                resp = _HTTP_SESSION.get(
                    cover_url, headers={"User-Agent": MB_USER_AGENT}, timeout=12
                )
                if resp.status_code == 200 and resp.content:
                    img_bytes = resp.content
                    mime = resp.headers.get("content-type", "image/jpeg").split(";")[0]
                    if cover_cache is not None:
                        if len(cover_cache) > 120:
                            cover_cache.clear()
                        cover_cache[cover_url] = (img_bytes, mime)
                elif cover_cache is not None:
                    cover_cache[cover_url] = None

            if img_bytes:
                if ext == ".flac" and FLAC is not None and Picture is not None:
                    fl = FLAC(str(full_path))
                    pic = Picture()
                    pic.data = img_bytes
                    pic.type = 3
                    pic.mime = mime
                    fl.clear_pictures()
                    fl.add_picture(pic)
                    fl.save()
                elif ext == ".mp3" and ID3 is not None and APIC is not None:
                    try:
                        tags = ID3(str(full_path))
                    except ID3NoHeaderError:
                        tags = ID3()
                    tags.delall("APIC")
                    tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=img_bytes))
                    tags.save(str(full_path))
                elif ext in (".m4a", ".mp4") and MP4 is not None and MP4Cover is not None:
                    mp4 = MP4(str(full_path))
                    fmt = MP4Cover.FORMAT_PNG if "png" in mime else MP4Cover.FORMAT_JPEG
                    mp4["covr"] = [MP4Cover(img_bytes, imageformat=fmt)]
                    mp4.save()

                if cfg.get("saveFolderCoverJpg", True):
                    folder_cover = full_path.parent / "cover.jpg"
                    if not folder_cover.exists():
                        folder_cover.write_bytes(img_bytes)
        except Exception:
            pass

    # Lyrics einbetten / .lrc Sidecar (WAV nur wenn WAV_EMBED_MEDIA=true)
    lyrics = track.get("lyrics") or {}
    synced_lrc = (lyrics.get("syncedLrc") or "").strip()
    plain_text = (lyrics.get("plainText") or "").strip()
    chosen_lyrics = synced_lrc if (cfg.get("preferSyncedLrc", True) and synced_lrc) else (plain_text or synced_lrc)
    if chosen_lyrics and cfg.get("fetchLyrics", True):
        if cfg.get("writeLrcSidecar", False) and synced_lrc:
            try:
                full_path.with_suffix(".lrc").write_text(synced_lrc, encoding="utf-8")
            except Exception:
                pass
        if cfg.get("embedLyricsInFile", True) and (not is_wav or cfg.get("wavEmbedMedia", False)):
            try:
                if ext == ".mp3" and ID3 is not None and USLT is not None:
                    tags = ID3(str(full_path))
                    tags.delall("USLT")
                    tags.add(USLT(encoding=3, lang="eng", desc="", text=chosen_lyrics))
                    tags.save(str(full_path))
                elif ext == ".flac" and FLAC is not None:
                    fl = FLAC(str(full_path))
                    fl["LYRICS"] = [chosen_lyrics]
                    fl.save()
                elif ext in (".m4a", ".mp4") and MP4 is not None:
                    mp4 = MP4(str(full_path))
                    mp4["\xa9lyr"] = [chosen_lyrics]
                    mp4.save()
            except Exception:
                pass

    return {"tagged": True}


_OS_JUNK_NAMES = {".ds_store", "thumbs.db", "desktop.ini", ".picasa.ini"}
_TARGET_ROOT_DIRS = {"lossless", "lossy", "_duplikate", "_review", "dj-remixes", "config"}


def _clean_os_junk_in_dir(dir_path: Path) -> None:
    try:
        for child in list(dir_path.iterdir()):
            name_low = child.name.lower()
            if child.is_file() and (name_low in _OS_JUNK_NAMES or child.name.startswith("._")):
                try:
                    child.unlink()
                except OSError:
                    pass
            elif child.is_dir() and name_low in ("@eadir", ".appledouble"):
                try:
                    if not any(child.iterdir()):
                        child.rmdir()
                except OSError:
                    pass
    except OSError:
        pass


def remove_truly_empty_dirs(dirs_to_check: List[Path]) -> List[str]:
    removed: List[str] = []
    seen = set()
    # Tiefste Ordner zuerst pruefen
    sorted_dirs = sorted(
        {d.resolve() for d in dirs_to_check},
        key=lambda p: len(p.parts),
        reverse=True,
    )
    for d in sorted_dirs:
        cur = d
        while cur != MUSIC_DIR and MUSIC_DIR in cur.parents:
            if cur in seen:
                break
            seen.add(cur)
            try:
                if not cur.exists() or not cur.is_dir():
                    break
                _clean_os_junk_in_dir(cur)
                if not any(cur.iterdir()):
                    cur.rmdir()
                    removed.append(cur.relative_to(MUSIC_DIR).as_posix())
                    cur = cur.parent
                else:
                    break
            except OSError:
                break
    return removed


_ORPHAN_CLEANUP_EXTS = {
    ".jpg",
    ".jpeg",
    ".jfif",
    ".png",
    ".webp",
    ".gif",
    ".bmp",
    ".tif",
    ".tiff",
    ".nfo",
    ".lrc",
    ".txt",
    ".log",
    ".accurip",
    ".cue",
    ".m3u",
    ".m3u8",
    ".pls",
    ".xspf",
    ".url",
    ".sfv",
    ".md5",
    ".ffp",
}


def cleanup_residual_source_dirs() -> Tuple[List[str], int, List[str]]:
    """Entfernt Alt-Ordner ausserhalb der Zielwurzeln (Lossless/Lossy/_Review/_Duplikate/DJ-Remixes),
    wenn darin KEINE Audio-, Video- oder sonstigen Benutzerdateien mehr liegen —
    sondern nur noch leere Unterordner, OS-Muell oder verwaiste Begleitdateien
    (z. B. album.nfo, artist.nfo, folder.jpg, cover.jpg, *.lrc, *.log, *.cue)."""
    if not _path_exists_safe(MUSIC_DIR):
        return [], 0, []
    removed_dirs: List[str] = []
    removed_files = 0
    kept_dirs: List[str] = []
    try:
        top_children = sorted(MUSIC_DIR.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return [], 0, []

    for top in top_children:
        if not top.is_dir() or top.name.lower() in _TARGET_ROOT_DIRS:
            continue
        # Bottom-up walk inside this legacy source folder
        for root_str, _dirnames, _filenames in os.walk(str(top), topdown=False):
            cur = Path(root_str)
            _clean_os_junk_in_dir(cur)
            try:
                remaining = list(cur.iterdir())
            except OSError:
                continue

            # Wenn noch Unterordner existieren, ist darunter noch eine geschuetzte Datei -> behalten
            if any(c.is_dir() for c in remaining):
                continue

            # Pruefen, ob ALLE verbleibenden Dateien ausschliesslich verwaiste Begleit-/Metadaten sind
            # (niemals Audio, niemals Video, niemals PDF/Archive/sonstige Benutzerdateien!)
            if remaining and all(
                c.is_file()
                and c.suffix.lower() in _ORPHAN_CLEANUP_EXTS
                and c.suffix.lower() not in AUDIO_EXTS
                and c.suffix.lower() not in VIDEO_EXTS
                for c in remaining
            ):
                for orphan in remaining:
                    try:
                        orphan.unlink()
                        removed_files += 1
                    except OSError:
                        pass
                try:
                    remaining = list(cur.iterdir())
                except OSError:
                    remaining = []

            if not remaining:
                try:
                    cur.rmdir()
                    removed_dirs.append(cur.relative_to(MUSIC_DIR).as_posix())
                except OSError:
                    pass

        if top.exists():
            kept_dirs.append(top.name)

    return removed_dirs, removed_files, kept_dirs


# ---------------------------------------------------------------------------
# 7. Hintergrund-Queue & 3-Modi API-Endpunkte
# ---------------------------------------------------------------------------
@dataclass
class QueueStatus:
    activeMode: Optional[str] = None
    status: str = "idle"
    processedCount: int = 0
    totalCount: int = 0
    errorCount: int = 0
    cacheHitCount: int = 0
    etaSeconds: int = 0
    currentTrackLabel: str = ""
    checkpointIndex: int = 0
    errors: List[Dict[str, Any]] = field(default_factory=list)


queue_state = QueueStatus()
pause_event = asyncio.Event()
pause_event.set()
active_task: Optional[asyncio.Task[Any]] = None


def ensure_state_loaded(
    force_rescan: bool = False,
    progress_cb: Optional[Callable[[int, int, str], None]] = None,
) -> Dict[str, Any]:
    if not force_rescan:
        persisted = load_persisted_state()
        if persisted and isinstance(persisted.get("tracks"), list):
            return persisted
    tracks, companions, leftovers = scan_music_directory(progress_cb=progress_cb)
    state = {
        "tracks": tracks,
        "companions": companions,
        "leftovers": leftovers,
        "mode1Completed": False,
        "mode2Completed": False,
        "mode3Completed": False,
        "scannedAt": datetime.now(timezone.utc).isoformat(),
    }
    save_persisted_state(state)
    return state


def _update_scan_progress(scanned: int, total: int, label: str) -> None:
    queue_state.processedCount = scanned
    queue_state.totalCount = total
    queue_state.currentTrackLabel = label


async def _run_analyze_job(
    start_index: int = 0,
    cfg_override: Optional[Dict[str, Any]] = None,
    preloaded_state: Optional[Dict[str, Any]] = None,
) -> None:
    global queue_state
    try:
        cfg = {**build_server_config(), **(cfg_override or {})}
        if preloaded_state is not None:
            state = preloaded_state
        else:
            queue_state = QueueStatus(
                activeMode="analyze",
                status="running",
                processedCount=0,
                totalCount=0,
                errorCount=0,
                cacheHitCount=0,
                etaSeconds=0,
                currentTrackLabel=f"Scanne Musikordner ({MUSIC_DIR}) …",
                checkpointIndex=start_index,
                errors=[],
            )
            existing_state = await asyncio.to_thread(load_persisted_state)
            if existing_state and len(existing_state.get("tracks") or []) > 0:
                state = existing_state
                if start_index == 0:
                    cp_stats = await asyncio.to_thread(read_cache_stats)
                    cp_idx = cp_stats.get("interruptedAnalyzeCheckpoint")
                    if isinstance(cp_idx, int) and 0 < cp_idx < len(state.get("tracks") or []):
                        start_index = cp_idx
                        print(
                            f"[TonArchiv] Setze gespeicherten Analyse-Fortschritt ab Track #{start_index} fort.",
                            flush=True,
                        )
            else:
                state = await asyncio.to_thread(
                    ensure_state_loaded, True, _update_scan_progress
                )

        tracks: List[Dict[str, Any]] = state.get("tracks") or []

        queue_state = QueueStatus(
            activeMode="analyze",
            status="running",
            processedCount=start_index,
            totalCount=len(tracks),
            errorCount=0,
            cacheHitCount=0,
            etaSeconds=max(0, len(tracks) - start_index),
            currentTrackLabel="",
            checkpointIndex=start_index,
            errors=[],
        )

        print(f"[TonArchiv] Modus 1 (Read-Only Analyse) gestartet fuer {len(tracks)} Tracks (ab #{start_index}).", flush=True)

        for idx in range(start_index, len(tracks)):
            await pause_event.wait()
            track = tracks[idx]
            queue_state.currentTrackLabel = f"{track.get('artist', '')} — {track.get('title', '')}"
            queue_state.etaSeconds = max(1, len(tracks) - idx)

            updated_track, hit, err_msg = await lookup_track_metadata(track, cfg)
            tracks[idx] = updated_track
            queue_state.processedCount = idx + 1
            queue_state.checkpointIndex = idx + 1
            if hit:
                queue_state.cacheHitCount += 1
            if err_msg:
                queue_state.errorCount += 1
                queue_state.errors.append(
                    {
                        "id": f"err-{idx}",
                        "stage": "MusicBrainz",
                        "trackLabel": track.get("fileName", ""),
                        "message": err_msg,
                        "recovered": True,
                    }
                )
                if len(queue_state.errors) > 25:
                    queue_state.errors = queue_state.errors[-25:]
            await asyncio.to_thread(save_checkpoint, "analyze", idx + 1, len(tracks))
            if (idx + 1) % 25 == 0 or idx + 1 == len(tracks):
                state["tracks"] = tracks
                snapshot = {**state, "tracks": list(tracks)}
                await asyncio.to_thread(save_persisted_state, snapshot)
                print(
                    f"[TonArchiv] Analyse: {idx + 1}/{len(tracks)} Tracks (Cache-Hits: {queue_state.cacheHitCount}, Hinweise: {queue_state.errorCount})",
                    flush=True,
                )

        state["tracks"] = tracks
        state["mode1Completed"] = True
        snapshot = {**state, "tracks": list(tracks)}
        await asyncio.to_thread(save_persisted_state, snapshot)
        await asyncio.to_thread(clear_checkpoint, "analyze")

        queue_state.status = "completed"
        queue_state.etaSeconds = 0
        queue_state.currentTrackLabel = ""
        print(f"[TonArchiv] Modus 1 abgeschlossen ({len(tracks)} Tracks).", flush=True)
    except Exception as exc:
        queue_state.status = "error"
        queue_state.currentTrackLabel = f"Analyse-Fehler: {exc}"
        print(f"[TonArchiv] Fehler in Modus 1: {exc}", flush=True)


async def _run_retry_failed_job(
    track_ids: Optional[List[str]] = None,
    include_unmatched: bool = False,
    req_cfg: Optional[Dict[str, Any]] = None,
) -> None:
    global queue_state
    cfg = {**build_server_config(), **(req_cfg or {})}
    try:
        state = await asyncio.to_thread(load_persisted_state)
        if not state or not (state.get("tracks") or []):
            queue_state = QueueStatus(
                activeMode="retry_failed",
                status="completed",
                processedCount=0,
                totalCount=0,
                errorCount=0,
                cacheHitCount=0,
                etaSeconds=0,
                currentTrackLabel="",
                checkpointIndex=0,
                errors=[],
            )
            return

        tracks: List[Dict[str, Any]] = state.get("tracks") or []
        explicit_set = set(track_ids) if track_ids else None
        target_indices: List[int] = []
        for idx, t in enumerate(tracks):
            if not isinstance(t, dict):
                continue
            if explicit_set is not None:
                if t.get("id") in explicit_set:
                    target_indices.append(idx)
            elif t.get("lookupError"):
                target_indices.append(idx)
            elif include_unmatched and not t.get("matchedRelease") and not t.get("mbRecordingId"):
                target_indices.append(idx)

        total_targets = len(target_indices)
        queue_state = QueueStatus(
            activeMode="retry_failed",
            status="running" if total_targets > 0 else "completed",
            processedCount=0,
            totalCount=total_targets,
            errorCount=0,
            cacheHitCount=0,
            etaSeconds=total_targets,
            currentTrackLabel="",
            checkpointIndex=0,
            errors=[],
        )

        if total_targets == 0:
            return

        print(
            f"[TonArchiv] Nachpruefung (MusicBrainz-Retry) gestartet fuer {total_targets} Tracks.",
            flush=True,
        )

        for step_idx, track_idx in enumerate(target_indices):
            await pause_event.wait()
            track = tracks[track_idx]
            queue_state.currentTrackLabel = f"{track.get('artist', '')} — {track.get('title', '')}"
            queue_state.etaSeconds = max(1, total_targets - step_idx)

            updated_track, hit, err_msg = await lookup_track_metadata(
                track, cfg, force_refresh=True
            )
            tracks[track_idx] = updated_track
            queue_state.processedCount = step_idx + 1
            queue_state.checkpointIndex = step_idx + 1
            if hit:
                queue_state.cacheHitCount += 1
            if err_msg:
                queue_state.errorCount += 1
                queue_state.errors.append(
                    {
                        "id": f"retry-err-{track_idx}",
                        "stage": "MusicBrainz",
                        "trackLabel": track.get("fileName", ""),
                        "message": err_msg,
                        "recovered": True,
                    }
                )
                if len(queue_state.errors) > 25:
                    queue_state.errors = queue_state.errors[-25:]

            if (step_idx + 1) % 15 == 0 or step_idx + 1 == total_targets:
                state["tracks"] = tracks
                snapshot = {**state, "tracks": list(tracks)}
                await asyncio.to_thread(save_persisted_state, snapshot)
                print(
                    f"[TonArchiv] Nachpruefung: {step_idx + 1}/{total_targets} Tracks (noch offen: {queue_state.errorCount})",
                    flush=True,
                )

        state["tracks"] = tracks
        snapshot = {**state, "tracks": list(tracks)}
        await asyncio.to_thread(save_persisted_state, snapshot)
        queue_state.status = "completed"
        queue_state.etaSeconds = 0
        queue_state.currentTrackLabel = ""
        print(
            f"[TonArchiv] Nachpruefung abgeschlossen ({total_targets} Tracks, verbleibende Fehler: {queue_state.errorCount}).",
            flush=True,
        )
    except Exception as exc:
        queue_state.status = "error"
        queue_state.currentTrackLabel = f"Nachpruefung-Fehler: {exc}"
        print(f"[TonArchiv] Fehler in Nachpruefung: {exc}", flush=True)


async def _startup_background_pipeline() -> None:
    global queue_state
    try:
        # Erst kurz warten, bis Uvicorn Port 7070 offen und Healthcheck gruen ist
        await asyncio.sleep(2.5)
        persisted = await asyncio.to_thread(load_persisted_state)
        if persisted is not None:
            print(
                f"[TonArchiv] Bestehender Stand geladen ({len(persisted.get('tracks') or [])} Tracks).",
                flush=True,
            )

        if not AUTO_ANALYZE_ON_START:
            print(
                "[TonArchiv] Web-UI aktiv (AUTO_ANALYZE_ON_START=false) — Scan/Modus 1 im Dashboard starten.",
                flush=True,
            )
            return

        if not _path_exists_safe(MUSIC_DIR):
            print(
                f"[TonArchiv] AUTO_ANALYZE_ON_START uebersprungen: MUSIC_DIR {MUSIC_DIR} nicht gefunden.",
                flush=True,
            )
            return

        if persisted is None:
            queue_state = QueueStatus(
                activeMode="analyze",
                status="running",
                currentTrackLabel=f"Scanne Musikordner ({MUSIC_DIR}) …",
            )
            state = await asyncio.to_thread(ensure_state_loaded, False, _update_scan_progress)
        else:
            state = persisted

        if len(state.get("tracks") or []) > 0 and not state.get("mode1Completed"):
            await _run_analyze_job(0, preloaded_state=state)
        elif queue_state.status == "running":
            queue_state.status = "idle"
            queue_state.currentTrackLabel = ""
    except Exception as exc:
        queue_state.status = "error"
        queue_state.currentTrackLabel = f"Startup-Scan fehlgeschlagen: {exc}"
        print(f"[TonArchiv] Startup-Hintergrundfehler: {exc}", flush=True)


def _execute_tag_entries(
    items: List[Dict[str, Any]],
    cfg: Dict[str, Any],
    mode_name: str,
    progress_cb: Optional[Callable[[int, int, str, bool], None]] = None,
) -> Tuple[int, int]:
    journal = load_journal()
    if not journal.get("backupConfirmedAt"):
        raise HTTPException(
            status_code=400,
            detail="Backup-Bestaetigung erforderlich, bevor Modus 2 Dateien beschreibt.",
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    run_id = f"run-{int(time.time())}"
    journal["runId"] = run_id
    journal["mode"] = mode_name
    journal["state"] = "in_progress"
    journal["lastFsyncIso"] = now_iso

    entries: List[Dict[str, Any]] = list(journal.get("entries") or [])
    planned_ops: List[Tuple[Dict[str, Any], Path, Dict[str, Any]]] = []
    skipped_count = 0

    for idx, item in enumerate(items):
        rel_path = item.get("sourceRelativePath")
        if not rel_path:
            continue
        full_path = safe_resolve_under_music(rel_path)
        if not full_path.exists():
            skipped_count += 1
            continue
        entry = {
            "id": f"tag-{item.get('id', idx)}-{int(time.time())}",
            "kind": "tag_track",
            "trackId": item.get("id"),
            "fromPath": rel_path,
            "toPath": rel_path,
            "originalTagsSnapshot": item.get("originalTags") or {},
            "status": "planned",
            "timestampIso": now_iso,
        }
        entries.append(entry)
        planned_ops.append((entry, full_path, item))

    # Write-Ahead-Journal EINMAL vor der ersten Dateiaenderung mit allen Original-Tags schreiben
    journal["entries"] = entries
    journal["lastFsyncIso"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(JOURNAL_PATH, journal)

    tagged_count = 0
    total_ops = len(planned_ops)
    cover_cache: Dict[str, Optional[Tuple[bytes, str]]] = {}

    for idx, (entry, full_path, item) in enumerate(planned_ops):
        res = write_tags_to_audio_file(
            full_path,
            item,
            cfg,
            is_dj_remix=bool(item.get("isDjRemix", False)),
            cover_cache=cover_cache,
        )
        ok = bool(res.get("tagged"))
        if ok:
            entry["status"] = "done"
            tagged_count += 1
        else:
            entry["status"] = "failed"
            skipped_count += 1
        entry["timestampIso"] = datetime.now(timezone.utc).isoformat()

        if progress_cb:
            label = f"{item.get('artist', '')} — {item.get('title', item.get('fileName', ''))}"
            progress_cb(idx + 1, total_ops, label, ok)

        if (idx + 1) % 25 == 0 or (idx + 1) == total_ops:
            journal["lastFsyncIso"] = entry["timestampIso"]
            atomic_write_json(JOURNAL_PATH, journal)

    journal["state"] = "completed"
    journal["lastFsyncIso"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(JOURNAL_PATH, journal)
    return tagged_count, skipped_count


def _unique_non_overwriting_path(dst_p: Path) -> Path:
    """Haengt bei existierender Zieldatei ' (2)', ' (3)' an, statt still zu ueberschreiben."""
    if not dst_p.exists():
        return dst_p
    stem = dst_p.stem
    suffix = dst_p.suffix
    parent = dst_p.parent
    for idx in range(2, 10_000):
        cand = parent / f"{stem} ({idx}){suffix}"
        if not cand.exists():
            return cand
    return dst_p


def _execute_move_entries(
    moves: List[Dict[str, Any]],
    companion_moves: List[Dict[str, Any]],
    cfg: Dict[str, Any],
    mode_name: str,
    progress_cb: Optional[Callable[[int, int, str, bool], None]] = None,
) -> Tuple[int, List[str], Dict[str, str]]:
    journal = load_journal()
    now_iso = datetime.now(timezone.utc).isoformat()
    journal["runId"] = f"run-{int(time.time())}"
    journal["mode"] = mode_name
    journal["state"] = "in_progress"
    journal["lastFsyncIso"] = now_iso

    entries: List[Dict[str, Any]] = list(journal.get("entries") or [])
    planned_ops: List[Tuple[Dict[str, Any], Path, Path]] = []

    for mv in moves:
        src_rel = mv.get("fromPath")
        dst_rel = mv.get("toPath")
        if not src_rel or not dst_rel or src_rel == dst_rel:
            continue
        src_p = safe_resolve_under_music(src_rel)
        dst_p = safe_resolve_under_music(dst_rel)
        entry = {
            "id": f"mv-{mv.get('trackId', len(entries))}-{int(time.time())}",
            "kind": "move_track",
            "trackId": mv.get("trackId"),
            "fromPath": src_rel,
            "toPath": dst_rel,
            "status": "planned",
            "timestampIso": now_iso,
        }
        entries.append(entry)
        planned_ops.append((entry, src_p, dst_p))

    if cfg.get("moveCompanionFiles", True):
        for cm in companion_moves:
            src_rel = cm.get("fromPath")
            dst_rel = cm.get("toPath")
            if not src_rel or not dst_rel or src_rel == dst_rel:
                continue
            src_p = safe_resolve_under_music(src_rel)
            dst_p = safe_resolve_under_music(dst_rel)
            entry = {
                "id": f"cmv-{cm.get('id', len(entries))}-{int(time.time())}",
                "kind": "move_companion",
                "fromPath": src_rel,
                "toPath": dst_rel,
                "status": "planned",
                "timestampIso": now_iso,
            }
            entries.append(entry)
            planned_ops.append((entry, src_p, dst_p))

    # Write-Ahead-Journal VOR dem ersten os.replace() schreiben
    journal["entries"] = entries
    journal["lastFsyncIso"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(JOURNAL_PATH, journal)

    moved_count = 0
    total_ops = len(planned_ops)
    touched_source_dirs: List[Path] = []
    src_to_dst_dirs: Dict[Path, Path] = {}
    actual_track_moves: Dict[str, str] = {}

    for idx, (entry, src_p, dst_p) in enumerate(planned_ops):
        ok = False
        try:
            if not src_p.exists():
                entry["status"] = "failed"
            elif src_p.resolve() == dst_p.resolve():
                entry["status"] = "done"
                ok = True
            else:
                final_dst = _unique_non_overwriting_path(dst_p)
                final_dst.parent.mkdir(parents=True, exist_ok=True)
                touched_source_dirs.append(src_p.parent)
                src_to_dst_dirs.setdefault(src_p.parent, final_dst.parent)
                try:
                    os.replace(src_p, final_dst)
                except OSError:
                    shutil.move(str(src_p), str(final_dst))

                # Zugehoerige .lrc-Sidecar-Datei aus Modus 2 direkt mitverschieben
                if entry.get("kind") == "move_track":
                    src_lrc = src_p.with_suffix(".lrc")
                    if src_lrc.exists() and src_lrc.is_file():
                        dst_lrc = _unique_non_overwriting_path(final_dst.with_suffix(".lrc"))
                        try:
                            os.replace(src_lrc, dst_lrc)
                        except OSError:
                            pass

                final_rel = final_dst.relative_to(MUSIC_DIR).as_posix()
                entry["toPath"] = final_rel
                entry["status"] = "done"
                entry["timestampIso"] = datetime.now(timezone.utc).isoformat()
                moved_count += 1
                ok = True
                if entry.get("kind") == "move_track" and entry.get("trackId"):
                    actual_track_moves[str(entry["trackId"])] = final_rel
        except Exception:
            entry["status"] = "failed"

        if progress_cb:
            progress_cb(idx + 1, total_ops, str(entry.get("toPath") or entry.get("fromPath") or ""), ok)

        if (idx + 1) % 25 == 0 or (idx + 1) == total_ops:
            journal["lastFsyncIso"] = datetime.now(timezone.utc).isoformat()
            atomic_write_json(JOURNAL_PATH, journal)

    # Von Modus 2 erzeugte cover.jpg-Dateien in den Zielordner uebernehmen (oder verwaiste Duplikate bereinigen)
    for src_dir_p, dst_dir_p in src_to_dst_dirs.items():
        if not src_dir_p.exists() or not src_dir_p.is_dir():
            continue
        src_cover = src_dir_p / "cover.jpg"
        if not src_cover.exists() or not src_cover.is_file():
            continue
        try:
            has_remaining_audio = any(
                c.is_file() and c.suffix.lower() in AUDIO_EXTS for c in src_dir_p.iterdir()
            )
        except OSError:
            has_remaining_audio = True
        if has_remaining_audio:
            continue
        dst_cover = dst_dir_p / "cover.jpg"
        try:
            dst_top = dst_dir_p.relative_to(MUSIC_DIR).parts[0].lower() if dst_dir_p != MUSIC_DIR else ""
        except ValueError:
            dst_top = ""
        if dst_top not in ("_duplikate", "_review") and not dst_cover.exists():
            try:
                dst_dir_p.mkdir(parents=True, exist_ok=True)
                os.replace(src_cover, dst_cover)
                continue
            except OSError:
                pass
        # Nur wenn im Quellordner sonst keine echten Dateien mehr liegen, verwaistes cover.jpg entfernen
        try:
            _clean_os_junk_in_dir(src_dir_p)
            others = [c for c in src_dir_p.iterdir() if c != src_cover]
            if not others:
                src_cover.unlink()
        except OSError:
            pass

    removed_dirs: List[str] = []
    if cfg.get("cleanupEmptyDirs", True):
        if touched_source_dirs:
            removed_dirs.extend(remove_truly_empty_dirs(touched_source_dirs))
        residual_dirs, _residual_files, _kept = cleanup_residual_source_dirs()
        removed_dirs.extend(residual_dirs)
        removed_dirs = list(dict.fromkeys(removed_dirs))
        journal["removedEmptyDirs"] = list(
            dict.fromkeys((journal.get("removedEmptyDirs") or []) + removed_dirs)
        )

    journal["state"] = "completed"
    journal["lastFsyncIso"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(JOURNAL_PATH, journal)
    return moved_count, removed_dirs, actual_track_moves


class BackupConfirmRequest(BaseModel):
    confirmed: bool


class ModeAnalyzeRequest(BaseModel):
    config: Optional[Dict[str, Any]] = None
    resumeFrom: int = 0


class ModeRetryFailedRequest(BaseModel):
    config: Optional[Dict[str, Any]] = None
    trackIds: Optional[List[str]] = None
    includeUnmatched: bool = False


class ModeTagRequest(BaseModel):
    config: Optional[Dict[str, Any]] = None
    tracks: Optional[List[Dict[str, Any]]] = None


class ModeMoveRequest(BaseModel):
    config: Optional[Dict[str, Any]] = None
    moves: List[Dict[str, Any]] = []
    companionMoves: List[Dict[str, Any]] = []
    resume: bool = False


class ModeRerunRequest(BaseModel):
    config: Optional[Dict[str, Any]] = None
    trackIds: List[str] = []
    tracks: List[Dict[str, Any]] = []
    moves: List[Dict[str, Any]] = []


class ModeRetagAudioIdRequest(BaseModel):
    config: Optional[Dict[str, Any]] = None
    scope: str = "review"  # "review" | "all" | "selected"
    trackIds: Optional[List[str]] = None
    useAudioId: bool = True


@app.on_event("startup")
async def on_startup() -> None:
    global active_task
    init_cache_db()
    static_ok = (STATIC_DIR / "index.html").is_file()
    print(
        f"[TonArchiv] Bereit auf Port 7070 | Web-UI={static_ok} | MUSIC_DIR={MUSIC_DIR} (exists={_path_exists_safe(MUSIC_DIR)}) | AUTO_ANALYZE_ON_START={AUTO_ANALYZE_ON_START}",
        flush=True,
    )
    active_task = asyncio.create_task(_startup_background_pipeline())


@app.get("/api/health")
async def api_health() -> Dict[str, Any]:
    journal = load_journal()
    return {
        "status": "ok",
        "music_dir": str(MUSIC_DIR),
        "music_dir_exists": _path_exists_safe(MUSIC_DIR),
        "essentia_available": ESSENTIA_AVAILABLE,
        "acoustid_configured": bool(ACOUSTID_API_KEY),
        "discogs_configured": bool(DISCOGS_TOKEN),
        "musicbrainz_contact": MUSICBRAINZ_CONTACT,
        "shazamio_enabled": ENABLE_SHAZAMIO,
        "shazamio_available": SHAZAMIO_AVAILABLE,
        "wav_embed_media": WAV_EMBED_MEDIA,
        "auto_analyze_on_start": AUTO_ANALYZE_ON_START,
        "journal_state": journal.get("state", "idle"),
        "config": build_server_config(),
    }


@app.get("/api/queue")
async def api_queue_status() -> Dict[str, Any]:
    return asdict(queue_state)


@app.post("/api/queue/pause")
async def api_queue_pause() -> Dict[str, Any]:
    pause_event.clear()
    queue_state.status = "paused"
    return asdict(queue_state)


@app.post("/api/queue/resume")
async def api_queue_resume() -> Dict[str, Any]:
    pause_event.set()
    if queue_state.activeMode:
        queue_state.status = "running"
    return asdict(queue_state)


@app.post("/api/rescan")
async def api_rescan() -> Dict[str, Any]:
    state = await asyncio.to_thread(ensure_state_loaded, True, _update_scan_progress)
    return {"rescanned": True, "trackCount": len(state.get("tracks") or [])}


def _summarize_kept_dir_reason(dir_name: str) -> str:
    target = MUSIC_DIR / dir_name
    if not target.exists() or not target.is_dir():
        return dir_name
    exts: List[str] = []
    has_audio = False
    has_video = False
    for _r, _dirs, files in os.walk(str(target)):
        for f in files:
            ext = Path(f).suffix.lower()
            if ext in AUDIO_EXTS:
                has_audio = True
            elif ext in VIDEO_EXTS:
                has_video = True
            elif ext and ext not in _ORPHAN_CLEANUP_EXTS and ext not in exts:
                exts.append(ext)
            if len(exts) >= 3 and has_audio and has_video:
                break
    tags: List[str] = []
    if has_audio:
        tags.append("Audio")
    if has_video:
        tags.append("Video")
    tags.extend(exts[:2])
    return f"{dir_name} ({', '.join(tags)})" if tags else dir_name


@app.post("/api/cleanup-empty")
async def api_cleanup_empty() -> Dict[str, Any]:
    removed_dirs, removed_files, kept_dirs = await asyncio.to_thread(cleanup_residual_source_dirs)
    kept_reasons = await asyncio.to_thread(
        lambda: [_summarize_kept_dir_reason(d) for d in kept_dirs[:8]]
    )
    return {
        "cleaned": True,
        "removedCount": len(removed_dirs),
        "removedFilesCount": removed_files,
        "removedDirs": removed_dirs[:50],
        "keptCount": len(kept_dirs),
        "keptSample": kept_dirs[:10],
        "keptReasons": kept_reasons,
    }


@app.post("/api/backup/confirm")
def api_confirm_backup(req: BackupConfirmRequest) -> Dict[str, Any]:
    if not req.confirmed:
        raise HTTPException(status_code=400, detail="Backup-Bestaetigung erforderlich.")
    journal = load_journal()
    journal["backupConfirmedAt"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(JOURNAL_PATH, journal)
    return {"confirmed": True, "backupConfirmedAt": journal["backupConfirmedAt"]}


@app.get("/api/journal")
async def api_get_journal() -> Dict[str, Any]:
    return load_journal()


@app.get("/api/state")
async def api_get_state() -> Dict[str, Any]:
    journal = load_journal()
    state = load_persisted_state() or {
        "tracks": [],
        "companions": [],
        "leftovers": [],
        "mode1Completed": False,
        "mode2Completed": False,
        "mode3Completed": False,
    }
    raw_tracks = list(state.get("tracks") or [])
    compact_tracks = [_compact_track_for_bulk_state(t) for t in raw_tracks if isinstance(t, dict)]
    raw_journal_entries = journal.get("entries") or []
    compact_journal_entries = [
        {
            "id": e.get("id", ""),
            "kind": e.get("kind", "tag_track"),
            "status": e.get("status", "done"),
        }
        for e in raw_journal_entries
        if isinstance(e, dict)
    ]
    compact_journal = {**journal, "entries": compact_journal_entries}
    return {
        "tracks": compact_tracks,
        "companions": list(state.get("companions") or []),
        "leftovers": list(state.get("leftovers") or []),
        "journal": compact_journal,
        "cache": read_cache_stats(),
        "queue": asdict(queue_state),
        "config": build_server_config(),
        "mode1Completed": bool(state.get("mode1Completed")),
        "mode2Completed": bool(state.get("mode2Completed"))
        or (journal.get("mode") in ("tag", "move", "rerun") and journal.get("state") == "completed"),
        "mode3Completed": bool(state.get("mode3Completed"))
        or (journal.get("mode") in ("move", "rerun") and journal.get("state") == "completed"),
    }


@app.get("/api/tracks/{track_id}")
async def api_get_track_detail(track_id: str) -> Dict[str, Any]:
    state = load_persisted_state()
    if not state:
        raise HTTPException(status_code=404, detail="Kein Zustand geladen.")
    for t in state.get("tracks") or []:
        if isinstance(t, dict) and t.get("id") == track_id:
            return t
    raise HTTPException(status_code=404, detail=f"Track {track_id} nicht gefunden.")


@app.post("/api/mode/analyze")
async def api_mode_analyze(req: ModeAnalyzeRequest) -> Dict[str, Any]:
    global active_task
    if active_task and not active_task.done():
        return {"started": False, "reason": "Analyse laeuft bereits", "queue": asdict(queue_state)}
    pause_event.set()
    active_task = asyncio.create_task(_run_analyze_job(req.resumeFrom, req.config))
    return {"started": True, "mode": "analyze"}


@app.post("/api/mode/retry-failed")
async def api_mode_retry_failed(req: ModeRetryFailedRequest) -> Dict[str, Any]:
    global active_task
    if active_task and not active_task.done():
        return {
            "started": False,
            "reason": "Eine Hintergrund-Aufgabe laeuft bereits",
            "queue": asdict(queue_state),
        }
    pause_event.set()
    active_task = asyncio.create_task(
        _run_retry_failed_job(req.trackIds, req.includeUnmatched, req.config)
    )
    return {"started": True, "mode": "retry_failed"}


async def _run_retag_audio_id_job(
    scope: str = "review",
    track_ids: Optional[List[str]] = None,
    use_audio_id: bool = True,
    req_cfg: Optional[Dict[str, Any]] = None,
) -> None:
    global queue_state
    cfg = {**build_server_config(), **(req_cfg or {})}
    threshold = float(cfg.get("confidenceThreshold", CONFIDENCE_THRESHOLD))
    try:
        state = await asyncio.to_thread(load_persisted_state)
        if not state or not (state.get("tracks") or []):
            queue_state = QueueStatus(
                activeMode="retag_audio_id",
                status="completed",
                processedCount=0,
                totalCount=0,
                errorCount=0,
                cacheHitCount=0,
                etaSeconds=0,
                currentTrackLabel="",
                checkpointIndex=0,
                errors=[],
            )
            return

        tracks: List[Dict[str, Any]] = state.get("tracks") or []
        explicit_set = set(track_ids) if track_ids else None
        target_indices: List[int] = []

        for idx, t in enumerate(tracks):
            if not isinstance(t, dict):
                continue
            if scope == "selected" and explicit_set is not None:
                if t.get("id") in explicit_set:
                    target_indices.append(idx)
            elif scope == "all":
                target_indices.append(idx)
            else:
                # scope == "review": alle Tracks in _Review/, ohne Release, mit niedriger Konfidenz oder Lookup-Fehler
                rel_p = str(t.get("sourceRelativePath") or "")
                conf = float(t.get("acoustidConfidence") or 0.0)
                if (
                    rel_p.startswith("_Review/")
                    or not t.get("matchedRelease")
                    or conf < threshold
                    or bool(t.get("lookupError"))
                ):
                    target_indices.append(idx)

        total_targets = len(target_indices)
        queue_state = QueueStatus(
            activeMode="retag_audio_id",
            status="running" if total_targets > 0 else "completed",
            processedCount=0,
            totalCount=total_targets,
            errorCount=0,
            cacheHitCount=0,
            etaSeconds=total_targets * 2,
            currentTrackLabel="",
            checkpointIndex=0,
            errors=[],
        )

        if total_targets == 0:
            return

        print(
            f"[TonArchiv] Audio-ID Nach-Taggen gestartet (Scope={scope}, Tracks={total_targets}, AcoustID={bool(ACOUSTID_API_KEY)}, ShazamIO={SHAZAMIO_AVAILABLE}).",
            flush=True,
        )

        for step_idx, track_idx in enumerate(target_indices):
            await pause_event.wait()
            track = tracks[track_idx]
            queue_state.currentTrackLabel = f"Musik-ID: {track.get('artist', '')} — {track.get('title', track.get('fileName', ''))}"
            queue_state.etaSeconds = max(1, (total_targets - step_idx) * 2)

            updated_track, hit, err_msg = await lookup_track_metadata(
                track, cfg, force_refresh=True, use_audio_id=use_audio_id
            )
            tracks[track_idx] = updated_track
            queue_state.processedCount = step_idx + 1
            queue_state.checkpointIndex = step_idx + 1
            if hit:
                queue_state.cacheHitCount += 1
            if err_msg:
                queue_state.errorCount += 1
                queue_state.errors.append(
                    {
                        "id": f"audioid-err-{track_idx}",
                        "stage": "Musik-ID",
                        "trackLabel": track.get("fileName", ""),
                        "message": err_msg,
                        "recovered": True,
                    }
                )
                if len(queue_state.errors) > 25:
                    queue_state.errors = queue_state.errors[-25:]

            if (step_idx + 1) % 10 == 0 or step_idx + 1 == total_targets:
                state["tracks"] = tracks
                snapshot = {**state, "tracks": list(tracks)}
                await asyncio.to_thread(save_persisted_state, snapshot)
                print(
                    f"[TonArchiv] Audio-ID Nach-Taggen: {step_idx + 1}/{total_targets} Tracks.",
                    flush=True,
                )

        state["tracks"] = tracks
        snapshot = {**state, "tracks": list(tracks)}
        await asyncio.to_thread(save_persisted_state, snapshot)
        queue_state.status = "completed"
        queue_state.etaSeconds = 0
        queue_state.currentTrackLabel = ""
        print(
            f"[TonArchiv] Audio-ID Nach-Taggen abgeschlossen ({total_targets} Tracks geprueft).",
            flush=True,
        )
    except Exception as exc:
        queue_state.status = "error"
        queue_state.currentTrackLabel = f"Musik-ID-Fehler: {exc}"
        print(f"[TonArchiv] Fehler bei Audio-ID Nach-Taggen: {exc}", flush=True)


@app.post("/api/mode/retag-audio-id")
async def api_mode_retag_audio_id(req: ModeRetagAudioIdRequest) -> Dict[str, Any]:
    global active_task
    if active_task and not active_task.done():
        return {
            "started": False,
            "reason": "Eine Hintergrund-Aufgabe laeuft bereits",
            "queue": asdict(queue_state),
        }
    pause_event.set()
    active_task = asyncio.create_task(
        _run_retag_audio_id_job(req.scope, req.trackIds, req.useAudioId, req.config)
    )
    return {
        "started": True,
        "mode": "retag_audio_id",
        "acoustidActive": bool(ACOUSTID_API_KEY),
        "shazamioActive": SHAZAMIO_AVAILABLE,
    }


def _merge_persisted_lyrics(
    incoming_tracks: List[Dict[str, Any]], persisted_tracks: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    by_id = {t.get("id"): t for t in persisted_tracks if isinstance(t, dict) and t.get("id")}
    merged: List[Dict[str, Any]] = []
    for item in incoming_tracks:
        if not isinstance(item, dict):
            continue
        persisted = by_id.get(item.get("id"))
        lyr = item.get("lyrics") if isinstance(item.get("lyrics"), dict) else {}
        if (
            persisted
            and isinstance(persisted.get("lyrics"), dict)
            and not lyr.get("syncedLrc")
            and not lyr.get("plainText")
            and lyr.get("status") != "instrumental"
        ):
            item = {**item, "lyrics": persisted["lyrics"]}
        merged.append(item)
    return merged


async def _run_tag_job(
    target_tracks: List[Dict[str, Any]],
    cfg: Dict[str, Any],
) -> None:
    global queue_state
    try:
        total = len(target_tracks)
        queue_state = QueueStatus(
            activeMode="tag",
            status="running" if total > 0 else "completed",
            processedCount=0,
            totalCount=total,
            errorCount=0,
            cacheHitCount=0,
            etaSeconds=max(1, total // 5) if total > 0 else 0,
            currentTrackLabel="Schreibe Write-Ahead-Journal (rollback.json) …",
            checkpointIndex=0,
            errors=[],
        )
        print(f"[TonArchiv] Modus 2 (Taggen) gestartet fuer {total} Tracks.", flush=True)

        def _on_tag_progress(done: int, tot: int, label: str, ok: bool) -> None:
            queue_state.processedCount = done
            queue_state.totalCount = tot
            queue_state.checkpointIndex = done
            queue_state.currentTrackLabel = label
            queue_state.etaSeconds = max(0, (tot - done) // 5)
            if not ok:
                queue_state.errorCount += 1
                queue_state.errors.append(
                    {
                        "id": f"tag-err-{done}",
                        "stage": "Mutagen",
                        "trackLabel": label,
                        "message": "Datei konnte nicht getaggt werden (uebersprungen).",
                        "recovered": True,
                    }
                )
                if len(queue_state.errors) > 25:
                    queue_state.errors = queue_state.errors[-25:]
            if done % 50 == 0 or done == tot:
                print(f"[TonArchiv] Modus 2 (Taggen): {done}/{tot} Tracks.", flush=True)

        tagged, skipped = await asyncio.to_thread(
            _execute_tag_entries, target_tracks, cfg, "tag", _on_tag_progress
        )

        state = await asyncio.to_thread(ensure_state_loaded, False)
        persisted_tracks = state.get("tracks") or []
        now_iso = datetime.now(timezone.utc).isoformat()
        tagged_ids = {t.get("id") for t in target_tracks}
        for t in persisted_tracks:
            if t.get("id") in tagged_ids:
                t["status"] = "tagged"
                t["taggedAt"] = now_iso
        state["mode1Completed"] = True
        state["mode2Completed"] = True
        snapshot = {**state, "tracks": list(persisted_tracks)}
        await asyncio.to_thread(save_persisted_state, snapshot)
        await asyncio.to_thread(clear_checkpoint, "analyze")

        queue_state.status = "completed"
        queue_state.processedCount = total
        queue_state.etaSeconds = 0
        queue_state.currentTrackLabel = ""
        print(
            f"[TonArchiv] Modus 2 abgeschlossen (getaggt: {tagged}, uebersprungen: {skipped}).",
            flush=True,
        )
    except Exception as exc:
        queue_state.status = "error"
        queue_state.currentTrackLabel = f"Tagging-Fehler: {exc}"
        print(f"[TonArchiv] Fehler in Modus 2: {exc}", flush=True)


@app.post("/api/mode/tag")
async def api_mode_tag(req: ModeTagRequest) -> Dict[str, Any]:
    global active_task
    if active_task and not active_task.done():
        return {
            "started": False,
            "reason": "Eine Hintergrund-Aufgabe laeuft bereits",
            "queue": asdict(queue_state),
        }
    journal = load_journal()
    if not journal.get("backupConfirmedAt"):
        raise HTTPException(
            status_code=400,
            detail="Backup-Bestaetigung erforderlich, bevor Modus 2 Dateien beschreibt.",
        )

    cfg = {**build_server_config(), **(req.config or {})}
    state = await asyncio.to_thread(ensure_state_loaded, False)
    persisted_tracks = state.get("tracks") or []
    target_tracks = (
        _merge_persisted_lyrics(req.tracks, persisted_tracks)
        if req.tracks is not None
        else persisted_tracks
    )
    pause_event.set()
    active_task = asyncio.create_task(_run_tag_job(target_tracks, cfg))
    return {"started": True, "mode": "tag", "total": len(target_tracks)}


async def _run_move_job(
    moves: List[Dict[str, Any]],
    companion_moves: List[Dict[str, Any]],
    cfg: Dict[str, Any],
) -> None:
    global queue_state
    try:
        total = len(moves) + (len(companion_moves) if cfg.get("moveCompanionFiles", True) else 0)
        queue_state = QueueStatus(
            activeMode="move",
            status="running" if total > 0 else "completed",
            processedCount=0,
            totalCount=total,
            errorCount=0,
            cacheHitCount=0,
            etaSeconds=max(1, total // 40) if total > 0 else 0,
            currentTrackLabel="Schreibe Write-Ahead-Journal (rollback.json) …",
            checkpointIndex=0,
            errors=[],
        )
        print(f"[TonArchiv] Modus 3 (Atomares Verschieben) gestartet fuer {total} Dateien.", flush=True)

        def _on_move_progress(done: int, tot: int, label: str, ok: bool) -> None:
            queue_state.processedCount = done
            queue_state.totalCount = tot
            queue_state.checkpointIndex = done
            queue_state.currentTrackLabel = label
            queue_state.etaSeconds = max(0, (tot - done) // 40)
            if not ok:
                queue_state.errorCount += 1
                queue_state.errors.append(
                    {
                        "id": f"move-err-{done}",
                        "stage": "Verschieben",
                        "trackLabel": label,
                        "message": "Datei nicht gefunden oder konnte nicht verschoben werden.",
                        "recovered": True,
                    }
                )
                if len(queue_state.errors) > 25:
                    queue_state.errors = queue_state.errors[-25:]
            if done % 100 == 0 or done == tot:
                print(f"[TonArchiv] Modus 3 (Verschieben): {done}/{tot} Dateien.", flush=True)

        moved, removed_dirs, actual_track_moves = await asyncio.to_thread(
            _execute_move_entries, moves, companion_moves, cfg, "move", _on_move_progress
        )

        # Pfade direkt im gespeicherten Zustand aktualisieren (kein 2-Minuten-ffprobe-Rescan noetig)
        state = await asyncio.to_thread(ensure_state_loaded, False)
        persisted_tracks = state.get("tracks") or []
        for t in persisted_tracks:
            tid = str(t.get("id") or "")
            new_rel = actual_track_moves.get(tid)
            if new_rel:
                t["sourceRelativePath"] = new_rel
                t["movedToPath"] = new_rel
                t["fileName"] = Path(new_rel).name
                parent_str = Path(new_rel).parent.as_posix()
                t["sourceDir"] = "" if parent_str == "." else parent_str
                t["status"] = "moved"
        state["mode1Completed"] = True
        state["mode2Completed"] = True
        state["mode3Completed"] = True
        snapshot = {**state, "tracks": list(persisted_tracks)}
        await asyncio.to_thread(save_persisted_state, snapshot)

        queue_state.status = "completed"
        queue_state.processedCount = total
        queue_state.etaSeconds = 0
        queue_state.currentTrackLabel = ""
        print(
            f"[TonArchiv] Modus 3 abgeschlossen (verschoben: {moved}, leere Ordner entfernt: {len(removed_dirs)}).",
            flush=True,
        )
    except Exception as exc:
        queue_state.status = "error"
        queue_state.currentTrackLabel = f"Verschiebe-Fehler: {exc}"
        print(f"[TonArchiv] Fehler in Modus 3: {exc}", flush=True)


@app.post("/api/mode/move")
async def api_mode_move(req: ModeMoveRequest) -> Dict[str, Any]:
    global active_task
    if active_task and not active_task.done():
        return {
            "started": False,
            "reason": "Eine Hintergrund-Aufgabe laeuft bereits",
            "queue": asdict(queue_state),
        }
    cfg = {**build_server_config(), **(req.config or {})}
    pause_event.set()
    active_task = asyncio.create_task(_run_move_job(req.moves, req.companionMoves, cfg))
    return {"started": True, "mode": "move", "total": len(req.moves)}


async def _run_rerun_job(
    merged_tracks: List[Dict[str, Any]],
    moves: List[Dict[str, Any]],
    cfg: Dict[str, Any],
) -> None:
    global queue_state
    try:
        total = len(merged_tracks) + len(moves)
        queue_state = QueueStatus(
            activeMode="rerun",
            status="running" if total > 0 else "completed",
            processedCount=0,
            totalCount=total,
            errorCount=0,
            cacheHitCount=0,
            etaSeconds=max(1, total // 5) if total > 0 else 0,
            currentTrackLabel="Schreibe neue Tags (Re-Run Modus 2 + 3) …",
            checkpointIndex=0,
            errors=[],
        )

        def _on_tag_p(done: int, _tot: int, label: str, ok: bool) -> None:
            queue_state.processedCount = done
            queue_state.currentTrackLabel = f"Tagge: {label}"
            queue_state.etaSeconds = max(0, (total - done) // 5)
            if not ok:
                queue_state.errorCount += 1

        tagged, skipped = await asyncio.to_thread(
            _execute_tag_entries, merged_tracks, cfg, "rerun", _on_tag_p
        )

        def _on_move_p(done: int, _tot: int, label: str, ok: bool) -> None:
            queue_state.processedCount = len(merged_tracks) + done
            queue_state.currentTrackLabel = f"Verschiebe: {label}"
            queue_state.etaSeconds = max(0, (total - queue_state.processedCount) // 20)
            if not ok:
                queue_state.errorCount += 1

        moved, removed_dirs, actual_track_moves = await asyncio.to_thread(
            _execute_move_entries, moves, [], cfg, "rerun", _on_move_p
        )

        state = await asyncio.to_thread(ensure_state_loaded, False)
        incoming_by_id = {
            str(item.get("id") or ""): item
            for item in merged_tracks
            if isinstance(item, dict) and item.get("id")
        }
        now_iso = datetime.now(timezone.utc).isoformat()
        for t in state.get("tracks") or []:
            tid = str(t.get("id") or "")
            inc = incoming_by_id.get(tid)
            if inc:
                for field in ("artist", "albumArtist", "title", "album", "year", "trackNumber", "genre"):
                    if inc.get(field) is not None:
                        t[field] = inc[field]
                t["taggedAt"] = now_iso
                t["pendingReRunTagAndMove"] = False
                if t.get("status") != "moved":
                    t["status"] = "tagged"
            if tid in actual_track_moves:
                new_rel = actual_track_moves[tid]
                t["sourceRelativePath"] = new_rel
                t["movedToPath"] = new_rel
                t["fileName"] = Path(new_rel).name
                parent_str = Path(new_rel).parent.as_posix()
                t["sourceDir"] = "" if parent_str == "." else parent_str
                t["status"] = "moved"
                t["pendingReRunTagAndMove"] = False
        state["mode1Completed"] = True
        state["mode2Completed"] = True
        state["mode3Completed"] = True
        await asyncio.to_thread(save_persisted_state, state)

        queue_state.status = "completed"
        queue_state.processedCount = total
        queue_state.etaSeconds = 0
        queue_state.currentTrackLabel = ""
        print(
            f"[TonArchiv] Gezielter Re-Run abgeschlossen (getaggt: {tagged}, uebersprungen: {skipped}, verschoben: {moved}, leere Ordner: {len(removed_dirs)}).",
            flush=True,
        )
    except Exception as exc:
        queue_state.status = "error"
        queue_state.currentTrackLabel = f"Re-Run-Fehler: {exc}"
        print(f"[TonArchiv] Fehler im Re-Run: {exc}", flush=True)


@app.post("/api/mode/rerun")
async def api_mode_rerun(req: ModeRerunRequest) -> Dict[str, Any]:
    global active_task
    if active_task and not active_task.done():
        return {
            "started": False,
            "reason": "Eine Hintergrund-Aufgabe laeuft bereits",
            "queue": asdict(queue_state),
        }
    journal = load_journal()
    if not journal.get("backupConfirmedAt"):
        raise HTTPException(
            status_code=400,
            detail="Backup-Bestaetigung erforderlich, bevor Dateien beschrieben werden.",
        )
    cfg = {**build_server_config(), **(req.config or {})}
    existing = await asyncio.to_thread(load_persisted_state) or {}
    merged_tracks = _merge_persisted_lyrics(req.tracks, existing.get("tracks") or [])
    pause_event.set()
    active_task = asyncio.create_task(_run_rerun_job(merged_tracks, req.moves, cfg))
    return {"started": True, "mode": "rerun", "total": len(merged_tracks) + len(req.moves)}


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
        to_path = safe_resolve_under_music(entry["toPath"])
        from_path = safe_resolve_under_music(entry["fromPath"])
        if (
            entry.get("kind") in ("move_track", "move_companion")
            and to_path.exists()
            and not from_path.exists()
        ):
            from_path.parent.mkdir(parents=True, exist_ok=True)
            os.replace(to_path, from_path)
            restored += 1
        elif entry.get("kind") == "tag_track" and from_path.exists():
            orig = entry.get("originalTagsSnapshot") or {}
            if orig:
                write_tags_to_audio_file(
                    from_path,
                    {
                        "artist": orig.get("artist", ""),
                        "albumArtist": orig.get("albumArtist", ""),
                        "title": orig.get("title", ""),
                        "album": orig.get("album", ""),
                        "year": orig.get("year", ""),
                        "trackNumber": orig.get("trackNumber", ""),
                        "genre": orig.get("genre", ""),
                        "originalTags": orig,
                    },
                    build_server_config(),
                    is_dj_remix=False,
                )
                restored += 1
        entry["status"] = "rolled_back"
    journal["state"] = "rolled_back"
    journal["lastFsyncIso"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(JOURNAL_PATH, journal)
    ensure_state_loaded(force_rescan=True)
    return {"rolledBack": True, "restored": restored}


# Statisches React-Dashboard direkt aus FastAPI ausliefern
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.exists():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API endpoint not found")
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(
            STATIC_DIR / "index.html",
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )
