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

# The solver is pinned to an official MiniZinc bundle (MiniZinc 2.8.7 + Gecode 6.3.0)
# instead of the distribution package, so that every campaign records one known
# solver version and local validation runs the very same binaries.
ARG MINIZINC_VERSION=2.8.7
ARG MINIZINC_SHA256=3d2dbe6572dc11a791ee27f46aca864561d9e491225bdf1eac22762c866cb1bc

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="/opt/minizinc/bin:$PNPM_HOME:$PATH"
# pnpm (via corepack), healthcheck tooling, tini and the shared libraries that the
# bundled fzn-gecode (built with Gist) links against. tini is PID 1: the solver runs in
# its own process group, and when it is killed its orphaned members must be reaped by
# an init, not left as zombies.
RUN corepack enable \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl tini \
		libgl1 libegl1 libfontconfig1 libfreetype6 libgmp10 libx11-6 libxcb1 libxdmcp6 \
		libbz2-1.0 libexpat1 libuuid1 libbsd0 libmd0 libbrotli1 libgpg-error0 zlib1g \
	&& rm -rf /var/lib/apt/lists/* \
	&& curl -fsSL -o /tmp/minizinc.tgz \
		"https://github.com/MiniZinc/MiniZincIDE/releases/download/${MINIZINC_VERSION}/MiniZincIDE-${MINIZINC_VERSION}-bundle-linux-x86_64.tgz" \
	&& echo "${MINIZINC_SHA256}  /tmp/minizinc.tgz" | sha256sum -c - \
	&& mkdir -p /opt/minizinc \
	&& tar -xzf /tmp/minizinc.tgz -C /opt/minizinc --strip-components=1 \
	&& rm /tmp/minizinc.tgz \
	&& rm -rf /opt/minizinc/bin/MiniZincIDE /opt/minizinc/plugins /opt/minizinc/bin/fzn-cp-sat \
		/opt/minizinc/bin/fzn-chuffed /opt/minizinc/bin/findMUS /opt/minizinc/bin/minizinc-globalizer \
	&& printf 'var 1..3: x;\nvar 0.0..1.0: y;\nconstraint y = 0.5 * x;\nsolve maximize x;\noutput ["x=\\(x) y=\\(y)\\n"];\n' > /tmp/selftest.mzn \
	&& minizinc --solver gecode /tmp/selftest.mzn | grep -q 'x=2 y=1.0' \
	&& minizinc --version \
	&& rm /tmp/selftest.mzn

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY tsconfig.json .
RUN pnpm install --frozen-lockfile

COPY src/ src/
COPY model/ model/
# Build and run the conformance suite, including the end-to-end MiniZinc/Gecode cases.
RUN pnpm run build && node --test dist/conformance.test.js

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
