# platform-agent-bridge - custom code, not a Ruflo image. See ../README.md
# "How it works" for why: neither Ruflo's CLI (bin/ruflo.js) nor its own
# bundled src/mcp-bridge/index.js has a way to register arbitrary MCP
# servers from config or gate calls against a risk-tiers.yaml-style
# policy - both were checked directly against the real npm package
# before writing this. This is a plain Express + @modelcontextprotocol/sdk
# service instead.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

FROM node:20-alpine
RUN apk add --no-cache dumb-init python3 py3-pip pipx \
    && pipx install uv \
    && ln -s /root/.local/bin/uvx /usr/local/bin/uvx
# uvx is needed at runtime: the Freshservice/Jira ITSM MCP servers this
# bridge spawns (see itsm-providers/providers/*.mcp.json) run via
# `uvx <package>`, not npx - they're Python packages.

RUN addgroup -g 10001 bridge && adduser -D -u 10001 -G bridge bridge
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
USER bridge

ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
