FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS base

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY


ENV HTTP_PROXY=$HTTP_PROXY \
	HTTPS_PROXY=$HTTPS_PROXY \
	NO_PROXY=$NO_PROXY \
	http_proxy=$HTTP_PROXY \
	https_proxy=$HTTPS_PROXY \
	no_proxy=$NO_PROXY

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Install pnpm (via corepack) + MiniZinc + healthcheck tooling. tini is PID 1: the solver runs in its own
# process group, and when it is killed its orphaned members must be reaped by an init, not left as zombies.
RUN corepack enable \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends minizinc curl tini \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY tsconfig.json .
RUN pnpm install --frozen-lockfile

COPY src/ src/
COPY model/ model/
RUN pnpm run build

# The solver's scratch directory (TMPDIR of every MiniZinc run) is the only place the unprivileged
# user writes to; code and dependencies stay owned by root.
RUN mkdir -p /app/tmp_minizinc && chown node:node /app/tmp_minizinc

EXPOSE 3000

# The laboratory profile (compose.lab-engines.json) builds this stage: the production image plus the
# test fixtures, so the same image serves the engine and runs the tests against the real MiniZinc
# (MINIZINC_REAL=1 node --test dist/minizinc_runner.test.js dist/cancel.test.js).
FROM base AS lab
COPY tests/ tests/
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]

# The final stage is the production image: builds without a `target` (compose.lab.json) end here. Keep it last.
FROM base AS production
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
