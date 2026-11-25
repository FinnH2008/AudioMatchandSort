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
import gc
import hashlib
import json
import os
import re
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
COMPANION_EXTS = {".jpg", ".jpeg", ".png", ".cue", ".log", ".m3u", ".m3u8", ".pdf"}

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


async def lookup_track_metadata(
    track: Dict[str, Any], cfg: Dict[str, Any], force_refresh: bool = False
) -> Tuple[Dict[str, Any], bool, Optional[str]]:
    """Fuehrt gecachte, rate-limitierte Live-Abfragen fuer einen Track aus (Read-Only)."""
    artist = (track.get("artist") or "").strip()
    title = (track.get("title") or "").strip()
    album = (track.get("album") or "").strip()
    cache_key = hashlib.sha1(
        f"{artist.lower()}|{title.lower()}|{album.lower()}|{track.get('durationSec', 0)}".encode("utf-8")
    ).hexdigest()

    cached_mb = None if force_refresh else cache_get("mb_release", cache_key)
    cache_hit = False
    candidates: List[Dict[str, Any]] = []
    available_releases: List[Dict[str, Any]] = []
    matched_release: Optional[Dict[str, Any]] = None
    acoustid_fallback_release: Optional[Dict[str, Any]] = None
    fallback_cover_url: Optional[str] = None
    fallback_cover_source: str = "Cover Art Archive"
    active_source: str = str(track.get("activeSource") or "musicbrainz")
    mb_recording_id = track.get("mbRecordingId")
    mb_artist_id = track.get("mbArtistId")
    acoustid_id = track.get("acoustidId")
    confidence = float(track.get("acoustidConfidence") or 0.0)
    threshold = float(cfg.get("confidenceThreshold", CONFIDENCE_THRESHOLD))
    err_msg: Optional[str] = None

    # 5a. AcoustID Fingerprint-Lookup (wenn ACOUSTID_API_KEY konfiguriert)
    if ACOUSTID_API_KEY and (not acoustid_id or force_refresh):
        fp_cache_key = hashlib.sha1(track["sourceRelativePath"].encode("utf-8")).hexdigest()
        fp_cached = None if force_refresh else cache_get("fingerprint", fp_cache_key)
        if fp_cached is not None:
            cache_hit = True
            acoustid_id = fp_cached.get("acoustidId")
            if fp_cached.get("mbRecordingId") and not mb_recording_id:
                mb_recording_id = fp_cached["mbRecordingId"]
            if fp_cached.get("score"):
                confidence = max(confidence, float(fp_cached["score"]))
            if isinstance(fp_cached.get("release"), dict):
                acoustid_fallback_release = fp_cached["release"]
        else:
            full_path = safe_resolve_under_music(track["sourceRelativePath"])
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
                    best = ac_data["results"][0]
                    acoustid_id = best.get("id")
                    score = float(best.get("score") or 0.0)
                    recs = best.get("recordings") or []
                    rec_id = recs[0].get("id") if recs else None
                    if rec_id:
                        mb_recording_id = rec_id
                    confidence = max(confidence, round(score, 2))
                    if recs:
                        rec0 = recs[0]
                        rec_artist = (
                            (rec0.get("artists") or [{}])[0].get("name") or artist
                        )
                        rec_title = rec0.get("title") or title
                        rgs = rec0.get("releasegroups") or []
                        rg_album = album
                        if rgs:
                            rg0 = rgs[0]
                            rg_album = rg0.get("title") or album
                            rg_sec = [s.lower() for s in (rg0.get("secondarytypes") or [])]
                            rg_is_comp = "compilation" in rg_sec
                            acoustid_fallback_release = {
                                "releaseId": f"acoustid-{rg0.get('id') or rec_id or 'rg'}",
                                "title": rg_album,
                                "albumArtist": "Various Artists" if rg_is_comp else rec_artist,
                                "year": track.get("year") or "",
                                "country": "XW",
                                "format": "Digital Media",
                                "trackCount": 1,
                                "isCompilation": rg_is_comp,
                                "isRemixAlbum": "remix" in rg_sec or "remix" in rg_album.lower(),
                                "matchScore": round(score, 2),
                                "tracklist": [
                                    {
                                        "position": 1,
                                        "title": rec_title,
                                        "durationSec": int(track.get("durationSec") or 0),
                                    }
                                ],
                            }
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
                                "year": track.get("year") or "",
                                "confidence": round(score, 2),
                                "mbRecordingId": rec_id,
                                "note": "Chromaprint Audio-Fingerprint via AcoustID",
                            }
                        )
                    cache_put(
                        "fingerprint",
                        fp_cache_key,
                        {
                            "acoustidId": acoustid_id,
                            "mbRecordingId": mb_recording_id,
                            "score": score,
                            "release": acoustid_fallback_release,
                        },
                    )

    # 5b. MusicBrainz Recording/Release Lookup (1 req/s Rate-Limiter)
    mb_data: Optional[Dict[str, Any]] = cached_mb
    if mb_data is not None:
        cache_hit = True
    elif title and title != "Unbekannt":
        await mb_limiter.acquire()
        q_parts = [f'recording:"{title.replace(chr(34), "")}"']
        if artist and "unbekannt" not in artist.lower():
            q_parts.append(f'artist:"{artist.replace(chr(34), "")}"')
        if album:
            q_parts.append(f'release:"{album.replace(chr(34), "")}"')
        query = " AND ".join(q_parts)
        mb_url = f"https://musicbrainz.org/ws/2/recording?query={quote(query)}&fmt=json&limit=5"
        mb_data = await asyncio.to_thread(
            _http_get_json,
            mb_url,
            {"User-Agent": MB_USER_AGENT, "Accept": "application/json"},
        )
        if mb_data is not None:
            cache_put("mb_release", cache_key, mb_data)
        else:
            err_msg = "MusicBrainz nicht erreichbar (übersprungen)."

    if mb_data and mb_data.get("recordings"):
        top = mb_data["recordings"][0]
        score_norm = round(min(0.99, float(top.get("score") or 0) / 100.0), 2)
        confidence = max(confidence, score_norm)
        mb_recording_id = top.get("id") or mb_recording_id
        ac_list = top.get("artist-credit") or []
        mb_artist = (
            "".join(
                (item.get("name") or item.get("artist", {}).get("name") or "") + (item.get("joinphrase") or "")
                for item in ac_list
            ).strip()
            or artist
        )
        if ac_list and ac_list[0].get("artist", {}).get("id"):
            mb_artist_id = ac_list[0]["artist"]["id"]
        mb_title = top.get("title") or title

        for rel in (top.get("releases") or [])[:5]:
            rel_id = rel.get("id") or ""
            rel_title = rel.get("title") or album
            rel_date = (rel.get("date") or "")[:4]
            rg = rel.get("release-group") or {}
            sec_types = [s.lower() for s in (rg.get("secondary-types") or [])]
            is_comp = "compilation" in sec_types
            raw_pos = track.get("matchedReleaseTrackPos")
            track_pos = int(raw_pos) if isinstance(raw_pos, int) and raw_pos > 0 else 1
            rel_obj = {
                "releaseId": rel_id,
                "title": rel_title,
                "albumArtist": "Various Artists" if is_comp else mb_artist,
                "year": rel_date or track.get("year") or "",
                "country": rel.get("country") or "XW",
                "format": "Digital Media",
                "trackCount": int(rel.get("track-count") or 1),
                "isCompilation": is_comp,
                "isRemixAlbum": "remix" in sec_types or "remix" in rel_title.lower(),
                "matchScore": score_norm,
                "tracklist": [
                    {
                        "position": track_pos,
                        "title": mb_title,
                        "durationSec": int(track.get("durationSec") or 0),
                    }
                ],
            }
            available_releases.append(rel_obj)

        if available_releases:
            matched_release = available_releases[0]
            active_source = "musicbrainz"

        candidates.append(
            {
                "provider": "musicbrainz",
                "artist": mb_artist,
                "albumArtist": matched_release["albumArtist"] if matched_release else mb_artist,
                "title": mb_title,
                "album": matched_release["title"] if matched_release else album,
                "year": matched_release["year"] if matched_release else (track.get("year") or ""),
                "confidence": score_norm,
                "mbRecordingId": mb_recording_id,
                "note": "MusicBrainz Release-Treffer",
            }
        )

    # 5c. Discogs Fallback (wenn DISCOGS_TOKEN konfiguriert und noch kein Release-Match oder Konfidenz < Schwellwert)
    if DISCOGS_TOKEN and (matched_release is None or confidence < threshold) and (artist or title):
        cached_discogs = None if force_refresh else cache_get("discogs", cache_key)
        d_data = cached_discogs
        if d_data is not None:
            cache_hit = True
        else:
            await discogs_limiter.acquire()
            q = f"{artist} {title}".strip()
            d_url = f"https://api.discogs.com/database/search?q={quote(q)}&type=release&per_page=3"
            d_data = await asyncio.to_thread(
                _http_get_json,
                d_url,
                {
                    "User-Agent": MB_USER_AGENT,
                    "Authorization": f"Discogs token={DISCOGS_TOKEN}",
                },
            )
            if d_data is not None:
                cache_put("discogs", cache_key, d_data)

        if d_data and d_data.get("results"):
            for r_idx, r_item in enumerate((d_data.get("results") or [])[:3]):
                d_title_full = r_item.get("title") or ""
                d_artist, d_album = (
                    d_title_full.split(" - ", 1) if " - " in d_title_full else (artist, d_title_full)
                )
                d_artist = d_artist.strip() or artist
                d_album = d_album.strip() or album
                d_year = str(r_item.get("year") or track.get("year") or "")
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
                    "matchScore": 0.85,
                    "tracklist": [
                        {
                            "position": 1,
                            "title": title,
                            "durationSec": int(track.get("durationSec") or 0),
                        }
                    ],
                }
                available_releases.append(d_rel)
                if r_idx == 0:
                    cov_img = str(r_item.get("cover_image") or "")
                    if cov_img and "spacer.gif" not in cov_img and not fallback_cover_url:
                        fallback_cover_url = cov_img
                        fallback_cover_source = "Discogs"
                    candidates.append(
                        {
                            "provider": "discogs",
                            "artist": d_artist,
                            "albumArtist": d_rel["albumArtist"],
                            "title": title,
                            "album": d_album,
                            "year": d_year,
                            "confidence": 0.85,
                            "note": "Discogs Katalog-Treffer (Fallback)",
                        }
                    )
            if matched_release is None and available_releases:
                matched_release = available_releases[0]
                active_source = "discogs"
            confidence = max(confidence, 0.85)

    # 5c-2. Deezer Public API Fallback (ohne API-Key, wenn MusicBrainz & Discogs keinen Treffer lieferten)
    if (matched_release is None or confidence < threshold) and title and title != "Unbekannt":
        cached_dz = None if force_refresh else cache_get("deezer", cache_key)
        dz_data = cached_dz
        if dz_data is not None:
            cache_hit = True
        else:
            await deezer_limiter.acquire()
            dz_q = (
                f'artist:"{artist.replace(chr(34), "")}" track:"{title.replace(chr(34), "")}"'
                if artist and "unbekannt" not in artist.lower()
                else title
            )
            dz_url = f"https://api.deezer.com/search?q={quote(dz_q)}&limit=3"
            dz_data = await asyncio.to_thread(
                _http_get_json, dz_url, {"User-Agent": MB_USER_AGENT}
            )
            if dz_data is not None:
                cache_put("deezer", cache_key, dz_data)

        if dz_data and dz_data.get("data"):
            dz0 = dz_data["data"][0]
            dz_artist = (dz0.get("artist") or {}).get("name") or artist
            dz_title = dz0.get("title") or title
            dz_alb = dz0.get("album") or {}
            dz_album = dz_alb.get("title") or album
            dz_cov = dz_alb.get("cover_xl") or dz_alb.get("cover_big") or dz_alb.get("cover_medium")
            if dz_cov and not fallback_cover_url:
                fallback_cover_url = str(dz_cov)
                fallback_cover_source = "Deezer"
            dz_rel = {
                "releaseId": f"deezer-{dz_alb.get('id') or dz0.get('id') or '0'}",
                "title": dz_album,
                "albumArtist": dz_artist,
                "year": track.get("year") or "",
                "country": "XW",
                "format": "Digital Media (Deezer)",
                "trackCount": 1,
                "isCompilation": dz_artist.lower() in ("various artists", "various"),
                "isRemixAlbum": "remix" in dz_album.lower(),
                "matchScore": 0.86,
                "tracklist": [
                    {
                        "position": 1,
                        "title": dz_title,
                        "durationSec": int(dz0.get("duration") or track.get("durationSec") or 0),
                    }
                ],
            }
            available_releases.append(dz_rel)
            candidates.append(
                {
                    "provider": "deezer",
                    "artist": dz_artist,
                    "albumArtist": dz_artist,
                    "title": dz_title,
                    "album": dz_album,
                    "year": track.get("year") or "",
                    "confidence": 0.86,
                    "note": "Deezer Katalog-Treffer (Fallback)",
                }
            )
            if matched_release is None:
                matched_release = dz_rel
                active_source = "deezer"
            confidence = max(confidence, 0.86)

    # 5c-3. AcoustID Release-Group Fallback, falls AcoustID Treffer hatte aber kein anderer Dienst
    if matched_release is None and acoustid_fallback_release is not None:
        available_releases.append(acoustid_fallback_release)
        matched_release = acoustid_fallback_release
        active_source = "musicbrainz"

    # Wenn MusicBrainz kurz nicht erreichbar war, aber Discogs/Deezer/AcoustID sauber gerettet hat -> kein Fehler!
    if err_msg and matched_release is not None and confidence >= threshold:
        err_msg = None

    # 5d. Cover Art Check (Cover Art Archive fuer MusicBrainz-UUIDs, sonst Discogs/Deezer-Cover)
    cover_patch = dict(track.get("cover") or {})
    if cfg.get("embedCover", True):
        rel_id = str(matched_release.get("releaseId") or "") if matched_release else ""
        is_mb_uuid = bool(rel_id) and not rel_id.startswith(("discogs-", "deezer-", "acoustid-"))
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
            and cover_patch.get("status") not in ("fetched", "existing")
        ):
            cover_patch = {
                **cover_patch,
                "status": "fetched",
                "source": fallback_cover_source,
                "resolution": f"<= {cfg.get('coverMaxSize', 1000)} px",
                "imageUrl": fallback_cover_url,
            }

    # 5e. LRCLIB Synced/Plain Lyrics Lookup
    lyrics_patch = dict(track.get("lyrics") or {})
    if cfg.get("fetchLyrics", True) and title:
        lyr_key = hashlib.sha1(f"{artist.lower()}|{title.lower()}".encode("utf-8")).hexdigest()
        cached_lyr = cache_get("lyrics", lyr_key)
        lyr_data = cached_lyr
        if lyr_data is None:
            lyr_url = f"https://lrclib.net/api/get?artist_name={quote(artist)}&track_name={quote(title)}"
            if album:
                lyr_url += f"&album_name={quote(album)}"
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
                    "source": "LRCLIB (Synced LRC)",
                    "syncedLrc": lyr_data["syncedLyrics"],
                    "plainText": lyr_data.get("plainLyrics") or "",
                }
            elif lyr_data.get("plainLyrics"):
                lyrics_patch = {
                    "status": "plain",
                    "source": "LRCLIB (Plain)",
                    "syncedLrc": "",
                    "plainText": lyr_data["plainLyrics"],
                }

    best_cand = (
        max(candidates, key=lambda c: float(c.get("confidence") or 0.0))
        if candidates
        else None
    )
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
        updated["artist"] = best_cand["artist"] or updated["artist"]
        updated["albumArtist"] = best_cand["albumArtist"] or updated["albumArtist"]
        updated["title"] = best_cand["title"] or updated["title"]
        if best_cand.get("album"):
            updated["album"] = best_cand["album"]
        if best_cand.get("year"):
            updated["year"] = best_cand["year"]

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

    easy = MutagenFile(str(full_path), easy=True)
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

    easy.save()

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
                if cur.exists() and cur.is_dir() and not any(cur.iterdir()):
                    cur.rmdir()
                    removed.append(cur.relative_to(MUSIC_DIR).as_posix())
                    cur = cur.parent
                else:
                    break
            except OSError:
                break
    return removed


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


def _execute_move_entries(
    moves: List[Dict[str, Any]],
    companion_moves: List[Dict[str, Any]],
    cfg: Dict[str, Any],
    mode_name: str,
) -> Tuple[int, List[str]]:
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
    atomic_write_json(JOURNAL_PATH, journal)

    moved_count = 0
    touched_source_dirs: List[Path] = []
    for entry, src_p, dst_p in planned_ops:
        if not src_p.exists() or dst_p.exists():
            entry["status"] = "failed"
            continue
        dst_p.parent.mkdir(parents=True, exist_ok=True)
        touched_source_dirs.append(src_p.parent)
        os.replace(src_p, dst_p)
        entry["status"] = "done"
        entry["timestampIso"] = datetime.now(timezone.utc).isoformat()
        moved_count += 1
        journal["lastFsyncIso"] = entry["timestampIso"]
        atomic_write_json(JOURNAL_PATH, journal)

    removed_dirs: List[str] = []
    if cfg.get("cleanupEmptyDirs", True) and touched_source_dirs:
        removed_dirs = remove_truly_empty_dirs(touched_source_dirs)
        journal["removedEmptyDirs"] = list(
            dict.fromkeys((journal.get("removedEmptyDirs") or []) + removed_dirs)
        )

    journal["state"] = "completed"
    journal["lastFsyncIso"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(JOURNAL_PATH, journal)
    return moved_count, removed_dirs


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
    return {
        "tracks": compact_tracks,
        "companions": list(state.get("companions") or []),
        "leftovers": list(state.get("leftovers") or []),
        "journal": journal,
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
        state["mode2Completed"] = True
        snapshot = {**state, "tracks": list(persisted_tracks)}
        await asyncio.to_thread(save_persisted_state, snapshot)

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


@app.post("/api/mode/move")
def api_mode_move(req: ModeMoveRequest) -> Dict[str, Any]:
    cfg = {**build_server_config(), **(req.config or {})}
    moved, removed_dirs = _execute_move_entries(req.moves, req.companionMoves, cfg, "move")
    state = ensure_state_loaded(force_rescan=True)
    state["mode1Completed"] = True
    state["mode2Completed"] = True
    state["mode3Completed"] = True
    save_persisted_state(state)
    return {"completed": True, "moved": moved, "removedEmptyDirs": removed_dirs}


@app.post("/api/mode/rerun")
def api_mode_rerun(req: ModeRerunRequest) -> Dict[str, Any]:
    cfg = {**build_server_config(), **(req.config or {})}
    existing = load_persisted_state() or {}
    merged_tracks = _merge_persisted_lyrics(req.tracks, existing.get("tracks") or [])
    tagged, skipped = _execute_tag_entries(merged_tracks, cfg, "rerun")
    moved, removed_dirs = _execute_move_entries(req.moves, [], cfg, "rerun")
    state = ensure_state_loaded(force_rescan=True)
    state["mode1Completed"] = True
    state["mode2Completed"] = True
    state["mode3Completed"] = True
    save_persisted_state(state)
    return {
        "completed": True,
        "tagged": tagged,
        "skipped": skipped,
        "moved": moved,
        "removedEmptyDirs": removed_dirs,
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
