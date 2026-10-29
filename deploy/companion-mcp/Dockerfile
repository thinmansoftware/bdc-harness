# Tailnet-only companion MCP image (WO-HARNESS-COMPANION-MCP-MAILBOX-01).
#
# Source packaging only. Building this image, mounting a real credential, and
# starting a container are go-live actions and are not part of this change.
FROM oven/bun:1.3-slim

# No default on purpose. A placeholder SHA would let the image advertise an
# identity it does not have.
ARG BUILD_SHA
ENV COMPANION_BUILD_SHA=${BUILD_SHA}
RUN test -n "${BUILD_SHA}" || (echo "BUILD_SHA build-arg is required (pass --build-arg BUILD_SHA=<sha>)" >&2; exit 1)

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 companion \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/companion companion \
  && mkdir -p /app /var/lib/companion-mcp \
  && chown -R companion:companion /app /var/lib/companion-mcp \
  && chmod 0750 /var/lib/companion-mcp

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/canary-suite/package.json ./packages/canary-suite/
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
COPY packages/security-watchdog/package.json ./packages/security-watchdog/
COPY packages/docs-web/package.json ./packages/docs-web/
COPY packages/fusion/package.json ./packages/fusion/
COPY packages/git/package.json ./packages/git/
COPY packages/isolation/package.json ./packages/isolation/
COPY packages/overseer/package.json ./packages/overseer/
COPY packages/paths/package.json ./packages/paths/
COPY packages/providers/package.json ./packages/providers/
COPY packages/server/package.json ./packages/server/
COPY packages/smart-cauldron/package.json ./packages/smart-cauldron/
COPY packages/web/package.json ./packages/web/
COPY packages/workflows/package.json ./packages/workflows/
COPY packages/persona-context-loader/package.json ./packages/persona-context-loader/
COPY packages/companion-mcp/package.json ./packages/companion-mcp/

RUN bun install --frozen-lockfile --production --filter @archon/companion-mcp \
  && chown -R companion:companion /app

COPY packages/companion-mcp ./packages/companion-mcp
RUN chown -R companion:companion /app

USER companion

EXPOSE 3095

CMD ["bun", "run", "packages/companion-mcp/src/server.ts"]
