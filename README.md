# TonArchiv — Homeserver Audio-Tagger & Sortierer (Port 7070)

Einzelner Docker-Container (FastAPI + Python-Audio-Pipeline + mobiles Web-Dashboard auf **Port 7070**).
Kein lokales `npm install`, kein Build auf dem Homeserver nötig: GitHub Actions baut das Multi-Arch-Image (`amd64` + `arm64`) automatisch bei jedem Push in die **GitHub Container Registry (GHCR)**.

---

## Plug-and-Play Deployment (einfach pullen, ENV eingeben, fertig)

### 1. Image automatisch auf GitHub bauen lassen (einmalig)
1. Pushe dieses Repository auf GitHub (`main`).
2. Unter **Actions → Build & Publish TonArchiv Docker Image** baut GitHub automatisch dein fertiges Image:
   `ghcr.io/<dein-github-name>/<dein-repo>:latest`
3. Öffne auf GitHub rechts unter **Packages → tonarchiv → Package settings** und stelle die Sichtbarkeit auf **Public** (dann kann Portainer/Docker ohne Registry-Login pullen).

### 2. In Portainer / Docker Compose pullen & starten
Füge die `docker-compose.yml` ein (oder wähle das GitHub-Repo in Portainer) und trage deine Umgebungsvariablen ein:

| Variable | Pflicht? | Beispiel / Standard | Beschreibung |
| :--- | :--- | :--- | :--- |
| `TONARCHIV_IMAGE` | **Ja** | `ghcr.io/<user>/<repo>:latest` | Dein fertiges GHCR-Image |
| `HOST_MUSIC_DIR` | **Ja** | `/srv/Music Full Quality` | Musikordner auf dem Host (genau ein Mount!) |
| `HOST_CONFIG_DIR` | Empfohlen | `/srv/tonarchiv/config` | Persistenter Ordner für Cache & Journal |
| `TONARCHIV_PORT` | Nein | `7070` | Port für das Web-Dashboard |
| `PUID` / `PGID` | Empfohlen | `1000` / `1000` | NAS-Benutzerrechte (`id -u` / `id -g`) |
| `AUTO_ANALYZE_ON_START` | Nein | `true` | Startet Modus 1 (Read-Only Analyse) direkt nach dem Booten |
| `ACOUSTID_API_KEY` | Optional | — | Kostenlos auf `acoustid.org/new-application` (Fingerprinting) |
| `DISCOGS_TOKEN` | Optional | — | Kostenlos auf `discogs.com/settings/developers` (DJ-Remixes) |
| `MUSICBRAINZ_CONTACT` | Optional | `mailto:du@example.de` | Kontakt für den MusicBrainz User-Agent |

> MusicBrainz, Cover Art Archive und LRCLIB funktionieren komplett **ohne API-Key**.

### 3. Öffnen & loslegen
Nach dem Deploy zieht Docker das fertige Image, übernimmt alle Umgebungsvariablen automatisch, scannt deinen gemounteten Musikordner und startet (bei `AUTO_ANALYZE_ON_START=true`) die Read-Only Analyse von alleine.

```
http://<deine-homeserver-ip>:7070
```

---

## Optional: Lokal bauen statt GHCR pullen
Falls du Änderungen lokal ohne GitHub Actions testen möchtest:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

---

## Sicherheit & die 3 sequenziellen Modi
1. **Modus 1 — Analyse (Read-Only):** Scannt Codecs via `ffprobe`, liest Tags per `mutagen`, prüft MusicBrainz/AcoustID/Discogs/Cover/Lyrics mit SQLite-Cache und Rate-Limiting. Verändert keine Dateien.
2. **Modus 2 — Taggen (mit Backup-Gate):** Erst nach Backup-Bestätigung aktiv. Schreibt Tags/Cover/Lyrics und sichert Original-Tags vorher im atomaren Journal (`rollback.json`). DJ-Remixes behalten Artist/Titel.
3. **Modus 3 — Verschieben & aufräumen:** Erst bei `0` offenen Künstlerkonflikten aktiv. Verschiebt Alben, Begleitdateien, `_Duplikate/` sowie `_Review/Lossless/` & `_Review/Lossy/` atomar per `os.replace()` innerhalb desselben Mounts. Videodateien bleiben immer unberührt.
