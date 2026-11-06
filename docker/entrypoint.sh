#!/bin/sh
# The image's entrypoint (spec 12, The image). The container starts as root. This script gives
# /data, /backups, and /run/secrets to the app's user, then runs the command as that user. PUID
# and PGID choose that UID and GID, for a NAS share that needs a set owner. Both default to 1000.
#
# `fft-entrypoint --no-chown <command>` skips the owner change. The Compose health check uses it
# to run as the app's user in the running container, where the start already changed the owners.
set -eu

# Every file and folder the command makes is the app's user's alone: app.db, its -wal and -shm
# files, jobs.db, and each backup (spec 11, What a backup holds). No other user on the host can
# read them.
umask 077

change_owners=true
if [ "${1-}" = --no-chown ]; then
  change_owners=false
  shift
fi

# Refuses 0, a leading 0, anything but a plain number, and any number above 2147483647, the
# largest ID Linux gives a user. setpriv reads an ID as 32 bits, so 4294967296 would wrap to 0,
# and 4294967295 means "keep root's ID". A typo can then never run the app as root.
check_id() {
  case $2 in
    '' | *[!0-9]* | 0*)
      ;;
    *)
      if [ "${#2}" -le 10 ] && [ "$2" -le 2147483647 ]; then return; fi
      ;;
  esac
  echo "fft: $1 must be a number above 0 and at most 2147483647, such as 1000. It is \"$2\"." >&2
  exit 1
}

uid=${PUID:-1000}
gid=${PGID:-1000}
check_id PUID "$uid"
check_id PGID "$gid"

# Started as another user already, such as with `docker run --user`: there is nothing to change.
if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

if [ "$change_owners" = true ]; then
  for folder in /data /backups /run/secrets; do
    [ -e "$folder" ] || continue
    # find -P never follows a symbolic link, and chown -h changes a link itself, never the file it
    # points to. A link planted in a folder can then never hand a file outside it to the app's
    # user. Only files with another owner change, so a large backups folder costs one pass of reads.
    find -P "$folder" \( ! -user "$uid" -o ! -group "$gid" \) -exec chown -h "$uid:$gid" {} + ||
      echo "fft: could not give every file in $folder to $uid:$gid, such as on a read-only mount." >&2
    # Owner-only, so a file made before the umask above, such as a 0644 app.db, is still closed
    # to other users. Only once the folder is the app's user's: on a share that squashes root, the
    # folder can keep another owner, and a chmod would shut the app's user out of it.
    if [ "$(stat -c %u "$folder")" = "$uid" ]; then
      chmod 700 "$folder" ||
        echo "fft: could not make $folder readable by $uid alone, such as on a read-only mount." >&2
    fi
  done
fi

# HOME is still root's home folder, which the app's user cannot read. Every user can read /tmp.
export HOME=/tmp

# setpriv ships in the base image (util-linux). It drops root's groups, and no-new-privs stops
# any program the app starts from gaining privileges. The shell after it is a second guard: it
# refuses to run the command if the real or effective UID or GID is still 0.
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- sh -c '
  for id in "$(id -ru)" "$(id -u)" "$(id -rg)" "$(id -g)"; do
    if [ "$id" = 0 ]; then
      echo "fft: refusing to run as root. Check PUID and PGID." >&2
      exit 1
    fi
  done
  exec "$@"
' fft-entrypoint "$@"
