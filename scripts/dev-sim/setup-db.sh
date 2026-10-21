#!/usr/bin/env bash
# Creates (or RE-creates) the throwaway database for the simulation and applies the migrations.
#   scripts/dev-sim/setup-db.sh            # database "referat_sim" on the local Postgres (>= 15)
#   DATABASE_URL=postgres://u:p@host:5432/other scripts/dev-sim/setup-db.sh
# It DROPS the database first, so it refuses any name that does not contain "sim" or "test".
set -euo pipefail
cd "$(dirname "$0")/../.."

URL="${DATABASE_URL:-postgres://localhost:5432/referat_sim}"
DB="${URL##*/}"; DB="${DB%%\?*}"
case "$DB" in
  *sim*|*test*) ;;
  *) echo "Refusing to drop database '$DB': its name must contain 'sim' or 'test'." >&2; exit 1 ;;
esac
ADMIN_URL="${URL%/*}/postgres"

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$DB\"" -c "CREATE DATABASE \"$DB\""
DATABASE_URL="$URL" node scripts/migrate.mjs
echo "Database $DB is ready."
