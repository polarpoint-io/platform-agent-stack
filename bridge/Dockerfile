# platform-agent-bridge - Express + @modelcontextprotocol/sdk service.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

FROM node:20-alpine
# uvx is needed at runtime: the Freshservice/Jira ITSM MCP servers this
# bridge spawns (see itsm-providers/providers/*.mcp.json) run via
# `uvx <package>`, not npx - they're Python packages.
#
# PIPX_HOME/PIPX_BIN_DIR matter. pipx's default (~/.local) resolves to
# /root here because this RUN is still root, and /root is mode 700 on
# alpine - the container then runs as uid 10001, which cannot traverse
# it. A symlink from /usr/local/bin into /root looks fine in `ls` and
# fails at exec with "spawn uvx EACCES", which surfaces only as a
# best-effort backend connect failure in mcpBackends.js. Install
# somewhere world-readable instead.
ENV PIPX_HOME=/opt/pipx \
    PIPX_BIN_DIR=/usr/local/bin
RUN apk add --no-cache dumb-init python3 py3-pip pipx \
    && pipx install uv \
    && chmod -R a+rX /opt/pipx

RUN addgroup -g 10001 bridge && adduser -D -u 10001 -G bridge bridge
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
USER bridge

# Fails the build if the runtime user still can't exec uvx. Checking
# this as root proves nothing - that was the original bug.
RUN uvx --version && npx --version

ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
