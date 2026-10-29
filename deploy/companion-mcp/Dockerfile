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

RUN groupadd --gid 10001 companion \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/companion companion \
  && mkdir -p /app \
  && chown -R companion:companion /app

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/companion-mcp ./packages/companion-mcp
RUN bun install --frozen-lockfile --production --filter @archon/companion-mcp \
  && chown -R companion:companion /app

USER companion

EXPOSE 3095

CMD ["bun", "run", "packages/companion-mcp/src/server.ts"]
