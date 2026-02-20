#!/bin/bash
set -e

echo "Waiting for PostgreSQL to be ready..."

# Extract host and port from DATABASE_URL
# Format: postgres://user:password@host:port/database
DB_HOST=$(echo $DATABASE_URL | sed -e 's|.*@||' -e 's|:.*||')
DB_PORT=$(echo $DATABASE_URL | sed -e 's|.*@[^:]*:||' -e 's|/.*||')

# Use Python to check PostgreSQL connectivity (asyncpg is already installed)
until python -c "
import socket
import sys
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(2)
    result = sock.connect_ex(('$DB_HOST', $DB_PORT))
    sock.close()
    sys.exit(0 if result == 0 else 1)
except Exception:
    sys.exit(1)
"; do
    echo "PostgreSQL is unavailable - sleeping"
    sleep 2
done

echo "PostgreSQL is up - running migrations..."

# Run database migrations
dbmate --url "$DATABASE_URL" up

echo "Migrations complete - starting server..."

# Start the application
exec uvicorn main:app --host 0.0.0.0 --port 8000
