#!/bin/sh
set -e

# A bind-mounted host directory arrives owned by root regardless of what the image set,
# because the mount replaces the image's own /app/data. The app runs unprivileged, so
# it cannot create anything inside it and dies at startup with EACCES.
#
# Named volumes do not have this problem — Docker seeds them from the image, ownership
# included — but bind mounts are the common choice on a PaaS, so fix it here and then
# drop privileges before exec'ing the app. If we are already unprivileged there is
# nothing to fix and nothing to drop.

DATA_DIR="${DATA_DIR:-/app/data}"
APP_UID="${APP_UID:-1000}"
APP_GID="${APP_GID:-1000}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"

  # Only recurse when the top directory is wrong. On a correctly-owned volume holding
  # thousands of downloaded clips, an unconditional chown -R would slow every restart.
  if [ "$(stat -c %u "$DATA_DIR")" != "$APP_UID" ]; then
    echo "entrypoint: taking ownership of $DATA_DIR for uid $APP_UID"
    chown -R "$APP_UID:$APP_GID" "$DATA_DIR"
  fi

  exec gosu "$APP_UID:$APP_GID" "$@"
fi

exec "$@"
