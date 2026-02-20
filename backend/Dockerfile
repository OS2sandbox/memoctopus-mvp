# syntax=docker/dockerfile:1

FROM python:3.12-slim-bookworm AS builder

# Install uv directly from official image (no curl needed)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install dbmate from official image
COPY --from=ghcr.io/amacneil/dbmate:latest /usr/local/bin/dbmate /usr/local/bin/dbmate

WORKDIR /app

# Copy dependency files first for better caching
COPY pyproject.toml uv.lock ./

# Install dependencies
RUN uv sync --frozen --no-dev

# Copy application code
COPY . .

# Production image
FROM python:3.12-slim-bookworm

WORKDIR /app

# Copy uv and dbmate from builder
COPY --from=builder /bin/uv /bin/uv
COPY --from=builder /bin/uvx /bin/uvx
COPY --from=builder /usr/local/bin/dbmate /usr/local/bin/dbmate

# Copy virtual environment and application
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app /app

# Set environment variables
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
