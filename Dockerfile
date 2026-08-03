# Ruflo has no published container image anywhere we could find (checked
# ghcr.io/ruvnet/ruflo, ghcr.io/ruvnet/ruflo/cli, docker.io/ruvnet/claude-flow,
# docker.io/ruflo/cli - all confirmed nonexistent via authenticated registry
# API calls, not just anonymous-pull denial). The one verified, real artifact
# is the npm package: https://www.npmjs.com/package/ruflo (a thin CLI wrapper
# around the actual @claude-flow/cli implementation, pulled in as a dependency).
#
# This builds our own image from that package. Published to
# ghcr.io/polarpoint-io/ruflo by .github/workflows/build-ruflo-image.yml.
# Consumed by both ruflo-bridge (args: mcp start -t http ...) and this
# repo's own Deployment (args: start --topology ...) - same image, different
# args, see each chart's templates/deployment.yaml for the verified-real
# CLI invocation (do not reintroduce the old "swarm start --config" args -
# that flag does not exist; see each Deployment's comments for why).
FROM node:20-alpine

RUN apk add --no-cache dumb-init \
    && npm install -g ruflo@latest \
    && npm cache clean --force

RUN addgroup -g 10001 ruflo && adduser -D -u 10001 -G ruflo ruflo
USER ruflo
WORKDIR /home/ruflo

ENTRYPOINT ["dumb-init", "--", "ruflo"]
CMD ["--help"]
