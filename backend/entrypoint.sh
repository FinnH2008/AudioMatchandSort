#!/bin/sh
set -u

CFG="${CONFIG_DIR:-/config}"
MDIR="${MUSIC_DIR:-/music}"
UID_NUM="$(printf '%s' "${PUID:-1000}" | tr -d '[:space:]')"
GID_NUM="$(printf '%s' "${PGID:-1000}" | tr -d '[:space:]')"

case "$UID_NUM" in
  ''|*[!0-9]*) UID_NUM=1000 ;;
esac
case "$GID_NUM" in
  ''|*[!0-9]*) GID_NUM=1000 ;;
esac

mkdir -p "$CFG" 2>/dev/null || true
chown -R "$UID_NUM:$GID_NUM" "$CFG" 2>/dev/null || true

echo "[TonArchiv] Starte FastAPI auf 0.0.0.0:7070 (PUID=$UID_NUM PGID=$GID_NUM MUSIC_DIR=$MDIR CONFIG_DIR=$CFG)"
if [ ! -d "$MDIR" ]; then
  echo "[TonArchiv] Hinweis: MUSIC_DIR '$MDIR' existiert im Container noch nicht (Volume pruefen)."
fi

export HOME="/tmp"

if [ "$UID_NUM" != "0" ] && command -v gosu >/dev/null 2>&1 && gosu "$UID_NUM:$GID_NUM" test -w "$CFG" 2>/dev/null; then
  exec gosu "$UID_NUM:$GID_NUM" python -m uvicorn app:app --app-dir /app --host 0.0.0.0 --port 7070 --proxy-headers --log-level info
else
  if [ "$UID_NUM" != "0" ]; then
    echo "[TonArchiv] Hinweis: $CFG fuer $UID_NUM:$GID_NUM nicht direkt beschreibbar — starte ohne UID-Wechsel."
  fi
  exec python -m uvicorn app:app --app-dir /app --host 0.0.0.0 --port 7070 --proxy-headers --log-level info
fi
