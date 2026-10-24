# SPACE api image for the optional laboratory pricing profile (compose.lab-pricing.json, service space-api).
#
# What it builds: the SPACE api of SCORELabUS/space at the commit ef4dc8949435d998e2aff525226e3fcc85e2f7ba (the commit
# of the 1.7.1 release; it is fetched by commit id only, because a release name can move). The source stage fetches that
# one commit and fails the build unless HEAD equals it. The build and runtime stages reproduce the upstream file
# api/docker/release/Dockerfile (node 21.1-slim, pnpm 10.9.0, frozen lockfile install, port 3000).
#
# Base images: the three digests (node 21.1, node 21.1-slim and, in lab/tools, python 3.12.8-slim-bookworm) come from a
# Docker Hub lookup of 24-10-2026 with MEDIUM confidence and have never been pulled. A wrong digest fails the build
# loudly; it never falls back to another image.
#
# Build context: the repository root or lab/space. No COPY reads the host, so the context may be lab/space:
#   docker build -t openbinding-lab/space-api:1.7.1 lab/space
#
# Runtime values (token signing, admin and database credentials) reach the container only as Compose environment
# references; nothing sensitive is an ARG or ENV here.
#
# Status: written by a worker without Docker or network access. Nothing here was built or run.

FROM node:21.1@sha256:0052410af98158173b17a26e0e2a46a3932095ac9a0ded660439a8ffae65b1e3 AS source

WORKDIR /src
RUN git init
RUN git fetch --depth 1 https://github.com/SCORELabUS/space.git ef4dc8949435d998e2aff525226e3fcc85e2f7ba
RUN git checkout --detach FETCH_HEAD
RUN test "$(git rev-parse HEAD)" = "ef4dc8949435d998e2aff525226e3fcc85e2f7ba"

FROM node:21.1-slim@sha256:cba276a6db06f49c589bcea35c598b5a960880ed5631bd4407a61c414ec7a9b9 AS build

RUN npm install -g pnpm@10.9.0
WORKDIR /usr/src/server

COPY --from=source /src/api/package.json /src/api/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY --from=source /src/api/tsconfig.json ./tsconfig.json
COPY --from=source /src/api/src/main ./src
RUN pnpm run build
RUN pnpm exec tsc-alias --project ./tsconfig.json --resolve-full-paths

FROM node:21.1-slim@sha256:cba276a6db06f49c589bcea35c598b5a960880ed5631bd4407a61c414ec7a9b9

WORKDIR /usr/src/server
ENV NODE_ENV=production

COPY --from=build --chown=1000:1000 /usr/src/server/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /usr/src/server/dist ./dist

EXPOSE 3000
USER 1000:1000
CMD ["node", "dist/index.js"]
