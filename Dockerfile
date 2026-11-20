# Family Hub: the server and the web app in one image.
#
#   docker build -t family-hub .
#
# Stage 1 builds the web app. Stage 2 is the server alone: it has no
# dependencies and Node runs its TypeScript directly, so the image holds
# only Node, the server's source and the built web app.

FROM node:24-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/mobile/package.json apps/mobile/
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/ui packages/ui
COPY apps/web apps/web
RUN npm run build -w @family-hub/web

FROM node:24-alpine
# Set by the release workflow to the version being released.
ARG VERSION=dev
ENV NODE_ENV=production \
    PORT=8080 \
    FAMILY_HUB_DATA=/data \
    FAMILY_HUB_WEB_DIR=/app/web \
    FAMILY_HUB_VERSION=${VERSION}
LABEL org.opencontainers.image.title="Family Hub" \
      org.opencontainers.image.description="A private, self-hosted hub for coordinating family life" \
      org.opencontainers.image.source="https://github.com/deanbirnie/family-hub" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app
# Takes the base image's fixes that came out after it was built, and removes
# the package managers it ships with: the server needs none, and each is code
# that could otherwise need security updates.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir /data && chown node:node /data
COPY apps/server/src ./server
RUN echo '{"type":"module"}' > package.json
COPY --from=web /src/apps/web/dist ./web
# Starts as root only long enough to take ownership of /data, then drops to
# PUID:PGID (default 1000:1000) before serving. See server/privileges.ts.
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server/main.ts"]
