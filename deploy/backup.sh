#!/bin/sh
set -eu
umask 077
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T db pg_dump -U seatraces_owner -d seatraces -Fc > "backups/seatraces-$stamp.dump"
test -s "backups/seatraces-$stamp.dump"
echo "Created backups/seatraces-$stamp.dump; copy to an independent encrypted backup destination."
