"""
TonArchiv — Single-Container FastAPI Service & Audio-Pipeline (Port 7070)
Serviert das gebaute React-Dashboard sowie alle /api/* Endpunkte ohne Node-Zwischenschicht.
Features:
- 3 sequenzielle Betriebsmodi: Modus 1 (Read-Only Analyse) -> Modus 2 (Taggen + Backup-Gate) -> Modus 3 (Verschieben) + Re-Run (Modus 2+3)
- Atomares Write-Ahead-Journal (rollback.json via temp + fsync + os.replace) inkl. Original-Tag-Snapshot
- Persistenter SQLite-Cache (/config/cache.db) + Fortschritts-Checkpoints + Rate-Limiting (MB 1/s, Discogs 60/min)
- Echte Codec-Inspektion via ffprobe + Mutagen-Tag-Lesen (ALAC != AAC, Videos unberuehrt)
- Album-First Release-Matching, konservative Kuenstler-Deduplizierung, album-bewusste Duplikate, DJ-Remix-Schutz & _Review/Lossless|Lossy
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import time
import unicodedata
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from mutagen import File as MutagenFile  # type: ignore
except Exception:
    MutagenFile = None

# Optionale Essentia-Integration (faellt sauber weg, wenn nicht installiert oder deaktiviert)
ENABLE_ESSENTIA = os.getenv("ENABLE_ESSENTIA", "false").lower() == "true"
try:
    if ENABLE_ESSENTIA:
        import essentia.standard as es  # type: ignore  # noqa: F401
        ESSENTIA_AVAILABLE = True
    else:
        ESSENTIA_AVAILABLE = False
except Exception:
    ESSENTIA_AVAILABLE = False

MUSIC_DIR = Path(os.getenv("MUSIC_DIR", "/srv/Music Full Quality")).resolve()
CONFIG_DIR = Path(os.getenv("CONFIG_DIR", "/config")).resolve()
CACHE_DB_PATH = CONFIG_DIR / "cache.db"
JOURNAL_PATH = CONFIG_DIR / "rollback.json"

CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.80"))
MIN_LOSSY_BITRATE = int(os.getenv("MIN_LOSSY_BITRATE", "256"))
DJ_REMIX_LAYOUT = os.getenv("DJ_REMIX_LAYOUT", "root_folder")
ENRICH_REMIX_EMPTY_FIELDS = os.getenv("ENRICH_REMIX_EMPTY_FIELDS", "true").lower() == "true"
KEEP_REVIEW_IN_PLACE = os.getenv("KEEP_REVIEW_IN_PLACE", "false").lower() == "true"
WAV_EMBED_MEDIA = os.getenv("WAV_EMBED_MEDIA", "false").lower() == "true"
ENABLE_SHAZAMIO = os.getenv("ENABLE_SHAZAMIO", "true").lower() == "true"
ACOUSTID_API_KEY = os.getenv("ACOUSTID_API_KEY", "").strip()
DISCOGS_TOKEN = os.getenv("DISCOGS_TOKEN", "").strip()
MUSICBRAINZ_CONTACT = os.getenv("MUSICBRAINZ_CONTACT", "https://github.com/tonarchiv").strip()

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

app = FastAPI(title="TonArchiv", version="1.0.0")

cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        return {
            "runId": None,
            "mode": "idle",
            "state": "idle",
            "backupConfirmedAt": None,
            "lastFsyncIso": None,
            "entries": [],
            "removedEmptyDirs": [],
        }
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
    """Erkennt echten Codec (ALAC vs AAC in .m4a) und schliesst Videos sauber aus."""
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
    bit_depth = int(bit_depth_raw) if bit_depth_raw and str(bit_depth_raw).isdigit() and int(bit_depth_raw) > 0 else None
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


def read_tags_from_file(path: Path, ffprobe_tags: Dict[str, Any]) -> Dict[str, Any]:
    tags_lower: Dict[str, str] = {str(k).lower(): str(v).strip() for k, v in ffprobe_tags.items() if v is not None}
    has_cover = False
    if MutagenFile is not None:
        try:
            mf = MutagenFile(str(path), easy=True)
            if mf is not None and mf.tags:
                for key in ("artist", "albumartist", "title", "album", "date", "tracknumber", "genre", "isrc"):
                    val = mf.tags.get(key)
                    if val:
                        tags_lower[key] = str(val[0]).strip()
            raw_mf = MutagenFile(str(path), easy=False)
            if raw_mf is not None:
                if getattr(raw_mf, "pictures", None):
                    has_cover = len(raw_mf.pictures) > 0
                elif raw_mf.tags and any(k.startswith("APIC") or k == "covr" for k in raw_mf.tags.keys()):
                    has_cover = True
        except Exception:
            pass
    return {"tags": tags_lower, "has_cover": has_cover}


def scan_music_directory() -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    tracks: List[Dict[str, Any]] = []
    companions: List[Dict[str, Any]] = []
    leftovers: List[Dict[str, Any]] = []

    if not MUSIC_DIR.exists():
        return tracks, companions, leftovers

    for root, _, filenames in os.walk(MUSIC_DIR):
        root_path = Path(root)
        for fname in sorted(filenames):
            if fname.startswith("."):
                continue
            full_path = root_path / fname
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
                continue

            if ext in COMPANION_EXTS:
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
                continue

            if ext not in AUDIO_EXTS:
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
                continue

            probed = probe_media_file(full_path)
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
                continue
            if probed.get("kind") != "audio":
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
                continue

            meta = read_tags_from_file(full_path, probed.get("tags") or {})
            t = meta["tags"]
            has_cover = bool(meta["has_cover"])

            raw_artist = t.get("artist") or "Unbekannter Kuenstler"
            raw_album_artist = t.get("albumartist") or t.get("album_artist") or raw_artist
            raw_title = t.get("title") or full_path.stem
            raw_album = t.get("album") or ""
            raw_year = (t.get("date") or t.get("year") or "")[:4]
            raw_track = (t.get("tracknumber") or t.get("track") or "").split("/")[0].zfill(2) if (t.get("tracknumber") or t.get("track")) else ""
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
                    "mbRecordingId": t.get("musicbrainz_trackid") or t.get("musicbrainz_recordingid") or None,
                    "mbArtistId": t.get("musicbrainz_artistid") or None,
                    "acoustidId": t.get("acoustid_id") or None,
                    "acoustidConfidence": 0.94 if (t.get("musicbrainz_trackid") or t.get("musicbrainz_recordingid")) else 0.0,
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

    return tracks, companions, leftovers


def sanitize_segment(name: str) -> str:
    cleaned = unicodedata.normalize("NFC", name)
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().rstrip(". ")
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
        "music_dir_exists": MUSIC_DIR.exists(),
        "essentia_available": ESSENTIA_AVAILABLE,
        "acoustid_configured": bool(ACOUSTID_API_KEY),
        "discogs_configured": bool(DISCOGS_TOKEN),
        "musicbrainz_contact": MUSICBRAINZ_CONTACT,
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
    tracks, companions, leftovers = scan_music_directory()
    with sqlite3.connect(CACHE_DB_PATH) as conn:
        counts = dict(conn.execute("SELECT namespace, COUNT(*) FROM lookup_cache GROUP BY namespace").fetchall())
        cp = conn.execute(
            "SELECT last_index, updated_at FROM job_checkpoints WHERE mode = 'analyze' ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
    return {
        "tracks": tracks,
        "companions": companions,
        "leftovers": leftovers,
        "journal": journal,
        "cache": {
            "dbPath": str(CACHE_DB_PATH),
            "fingerprintEntries": counts.get("fingerprint", 0),
            "mbReleaseEntries": counts.get("mb_release", 0),
            "coverEntries": counts.get("cover", 0),
            "lyricsEntries": counts.get("lyrics", 0),
            "lastCheckpointIso": cp[1] if cp else None,
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
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str) -> FileResponse:
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
