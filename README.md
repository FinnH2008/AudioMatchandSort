# TonArchiv — Homeserver Docker Audio-Tagger & Aufräumer

TonArchiv läuft als **einzelner Docker-Container (FastAPI + React-Dashboard)** auf **Port `7070`** ohne Node-Zwischenschicht im Betrieb.
Er prüft Formate über den tatsächlichen Codec (`ffprobe`), führt drei getrennte Modi (**Nur analysieren → Taggen → Verschieben & aufräumen**) aus, bettet Cover, Songtexte, Tonart & BPM per `mutagen` ein und protokolliert alle Operationen atomar im Write-Ahead-Journal (`rollback.json`).

---

## Direkt von GitHub in Docker starten (Port 7070)

```bash
# 1. Repository von GitHub klonen
git clone https://github.com/<dein-user>/<dein-repo>.git tonarchiv
cd tonarchiv

# 2. .env aus Vorlage erstellen und anpassen (Host-Pfad, PUID/PGID, optionale API-Keys)
cp .env.example .env
nano .env

# 3. Container bauen und starten
docker compose up -d --build

# 4. Web-Dashboard im Browser öffnen
http://<deine-homeserver-ip>:7070
```

> **Portainer / Dockge:** Du kannst dieses GitHub-Repository auch direkt als *Git Repository Stack* einbinden (`docker-compose.yml` liegt im Root) und die Variablen aus `.env.example` als Stack-Environment-Variablen eintragen.

---

## Umgebungsvariablen (`.env`) & API-Keys

Alle API-Keys sind **optional** — fehlt ein Key, wird nur die jeweilige Stufe sauber mit Hinweis deaktiviert, ohne den Container zum Absturz zu bringen.

| Variable | Pflicht? | Standard | Beschreibung / Woher bekomme ich den Key? |
| --- | --- | --- | --- |
| `TONARCHIV_PORT` | Nein | `7070` | Port auf deinem Homeserver für das Dashboard & die API |
| `HOST_MUSIC_DIR` | **Ja** | `/srv/Music Full Quality` | Echter Pfad zu deinem Musikordner auf dem Host (genau **ein** Mount!) |
| `MUSIC_DIR` | Nein | `/srv/Music Full Quality` | Pfad im Container (normalerweise identisch mit `HOST_MUSIC_DIR`) |
| `HOST_CONFIG_DIR` | Nein | `./config` | Host-Ordner für SQLite-Cache (`cache.db`) und Journal (`rollback.json`) |
| `PUID` / `PGID` | **Ja** | `1000` / `1000` | Benutzer- & Gruppen-ID deines NAS-Nutzers (`id -u` / `id -g`) |
| `ACOUSTID_API_KEY` | Optional (empfohlen) | *(leer)* | Für Audio-Fingerprinting (Chromaprint). Kostenlos unter `https://acoustid.org/new-application` |
| `DISCOGS_TOKEN` | Optional | *(leer)* | Personal Access Token für Vinyl-/Club-/EP-Releases. Kostenlos unter `https://www.discogs.com/settings/developers` |
| `MUSICBRAINZ_CONTACT` | Optional | *(leer)* | Kontakt-E-Mail oder Repo-URL für den MusicBrainz User-Agent (**MusicBrainz benötigt keinen API-Key**) |
| `ENABLE_SHAZAMIO` | Nein | `true` | Optionales ShazamIO-Fallback für Remixes/Edits (inoffizielle API, Fehler brechen nie ab) |
| `ENABLE_ESSENTIA` | Nein | `false` | Optionales Audio-Analyse-Modul (Tonart, BPM, Fake-FLAC-Heuristik; erhöht Build-Zeit/RAM) |
| `WAV_EMBED_MEDIA` | Nein | `false` | Cover/Lyrics in WAV-Dateien einbetten (standardmäßig `false`, da WAV-Tags je nach Player unzuverlässig sind) |

**Ohne API-Key nutzbar:** MusicBrainz, Cover Art Archive, LRCLIB (synchronisierte Songtexte) und Deezer-Metadaten benötigen **keinen API-Key**.

---

## Erster Testlauf

> **Empfehlung:** Führe TonArchiv beim ersten Einsatz **unbedingt auf einer Testkopie mit 50–100 repräsentativen Dateien** aus (z. B. je ein FLAC-Album, ein M4A/ALAC-Album, ein MP3-Album, eine Compilation und ein paar DJ-Remixes), bevor du deine gesamte Bibliothek einbindest.

Trage dazu zuerst `HOST_MUSIC_DIR=/srv/music-test` in der `.env` ein, starte `docker compose up -d --build` und öffne `http://<deine-homeserver-ip>:7070`.

---

## Dateisystem & Rechte

### Atomares Verschieben erfordert ein gemeinsames Dateisystem (ein Mount)
Mounte deinen Musikordner immer über **genau einen Volume-Eintrag** (`${HOST_MUSIC_DIR}:${MUSIC_DIR}`).
Nur innerhalb desselben gemounteten Dateisystems arbeitet `os.replace()` / `rename()` atomar, verlustfrei und ohne Datenkopie. Bei getrennten Mounts oder verschiedenen Partitionen schlägt atomares Umbenennen (`EXDEV`) fehl.

### Dateirechte mit `PUID` und `PGID`
Auf Homeservern (Unraid, Synology, TrueNAS, Linux mit SMB-Freigaben) sollten neu erstellte Ordner und getaggte Dateien deinem NAS-Benutzer gehören — nicht `root`.
Ermittle deine IDs auf dem Host mit:

```bash
id -u   # -> PUID
id -g   # -> PGID
```

Trage beide Werte in `.env` ein. Der Container startet FastAPI direkt per `gosu` unter exakt dieser `PUID:PGID`.

---

## Sicherheit & Empfehlungen

1. **Backup vor Modus 2 (Pflicht):** Erstelle vor dem ersten Schreiblauf ein vollständiges Backup oder einen Dateisystem-Snapshot (ZFS / Btrfs / Synology Snapshot). Das Journal `rollback.json` sichert Original-Tags und Pfade für Rollbacks und Crash-Recovery, ersetzt aber kein Backup.
2. **Reihenfolge der 3 Modi:**
   - **Modus 1 — Nur analysieren (Read-Only):** Prüft Codecs, Releases, Duplikate, DJ-Remixes & Künstler ohne Schreibzugriff.
   - **Modus 2 — Taggen:** Schreibt Metadaten, Cover & Songtexte für alle konfliktfreien Tracks mit Konfidenz ≥ `0.80` (Konflikt-Tracks werden übersprungen und gelistet; DJ-Remixes behalten `Artist` & `Titel`).
   - **Modus 3 — Verschieben & aufräumen:** Erst bei `0` offenen Künstlerkonflikten aktiv. Verschiebt Alben samt Begleitdateien, DJ-Remixes, bestätigte Duplikate (`_Duplikate/`) und `review`-Tracks (`_Review/Lossless/` & `_Review/Lossy/`) atomar über das Journal und löscht ausschließlich wirklich leere Ordner.
3. **Bekannte Grenzen:**
   - **ShazamIO** ist eine inoffizielle API (per `ENABLE_SHAZAMIO=false` abschaltbar; Fehler brechen nie den Lauf ab).
   - **Spektral-Cutoff-Check (Fake-FLAC)** ist eine Heuristik und markiert Dateien ausschließlich mit einer Warnung (nie automatisches Umsortieren).
   - **WAV-Tags** sind je nach Player unzuverlässig (`WAV_EMBED_MEDIA=false` als Standard).
   - **Essentia** ist optional (`ENABLE_ESSENTIA=false` als Standard).
4. **Bewährte Alternativen:** Für skriptbare CLI-Verwaltung siehe **beets** (`https://beets.io`), für gezieltes Desktop-Tagging **MusicBrainz Picard** (`https://picard.musicbrainz.org`).
