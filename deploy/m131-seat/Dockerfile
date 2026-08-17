# M-131 Phase A seat image (WO-HARNESS-M131-PHASE-A-GROK-SEAT-PROOF-01).
#
# One reusable, non-root dispatch-worker image; per-seat identity, provider
# restriction, and mounts come from the compose service, so the same image
# serves future seats without rebuild-per-provider drift.
#
# This file is source packaging only. Building it on a live host, mounting a
# real credential, and starting a container are separately gated actions and
# never part of a source PR.
FROM oven/bun:1.3-slim

# Build-SHA visibility: the image carries the exact source SHA it was built
# from, surfaced to preflight/health via SEAT_BUILD_SHA.
ARG BUILD_SHA=unknown
ENV SEAT_BUILD_SHA=${BUILD_SHA}

# Non-root seat user with a real home for the seat-private vendor profile.
RUN groupadd --gid 10001 seat \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/seat seat \
  && mkdir -p /app /var/lib/bdc-seat /run/m131/secret-ingress \
  && chown -R seat:seat /app /var/lib/bdc-seat /home/seat

WORKDIR /app

# Worker source + the minimal dependency set it imports at runtime.
COPY --chown=seat:seat package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=seat:seat scripts/dispatch-worker ./scripts/dispatch-worker

USER seat

# Health = the same deterministic preflight that gates advertisement.
# Sanitized output only (typed code + field); never paths or credentials.
HEALTHCHECK --interval=60s --timeout=15s --retries=3 CMD \
  bun run scripts/dispatch-worker/seat-preflight.ts --config /app/config/seat.json || exit 1

CMD ["bun", "run", "scripts/dispatch-worker/index.ts", "--config", "/app/config/seat.json"]
