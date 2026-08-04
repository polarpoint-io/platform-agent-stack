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

# -h/mkdir/chown explicitly: the home directory was never actually
# created before, and nothing set HOME either. Node falls back to
# os.homedir() (the passwd entry) when HOME is unset, so npm resolved
# /home/bridge and got ENOENT rather than a permissions error - which
# reads like a read-only-filesystem problem and isn't one.
RUN addgroup -g 10001 bridge \
    && adduser -D -u 10001 -G bridge -h /home/bridge bridge \
    && mkdir -p /home/bridge \
    && chown -R bridge:bridge /home/bridge
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
USER bridge
# USER does not change HOME - Docker leaves it at the base image's value.
# Without this, anything below runs as uid 10001 while still pointed at
# root's home. The chart overrides HOME to /tmp at runtime, because the
# rootfs is read-only there; this is the build-time value only.
ENV HOME=/home/bridge

# Fails the build if the runtime user can't exec uvx. Verifying as root
# proves nothing - that was the original bug. npx is deliberately not
# checked: nothing spawns it any more now that the kubernetes and
# prometheus servers are out of mcp/base.mcp.json.
RUN uvx --version

ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
