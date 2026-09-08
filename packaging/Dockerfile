# Packaging only: build the unchanged upstream static application.
FROM --platform=$BUILDPLATFORM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS build
WORKDIR /app
COPY upstream/package.json upstream/package-lock.json ./
RUN npm ci --include=dev
COPY upstream/ ./
RUN npm run build

FROM nginx:1.27.3-alpine@sha256:814a8e88df978ade80e584cc5b333144b9372a8e3c98872d07137dbf3b44d0e4
COPY --from=build /app/dist/ /lzcapp/pkg/content/web/
COPY upstream/LICENSE /lzcapp/pkg/content/LICENSE
COPY lazycat/content/nginx.conf lazycat/content/start.sh /lzcapp/pkg/content/
EXPOSE 80
ENTRYPOINT ["/bin/sh", "/lzcapp/pkg/content/start.sh"]
