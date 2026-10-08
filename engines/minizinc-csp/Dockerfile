FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

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
# Install pnpm (via corepack) + MiniZinc + healthcheck tooling
RUN corepack enable \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends minizinc curl \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY tsconfig.json .
RUN pnpm install --frozen-lockfile

COPY src/ src/
COPY model/ model/
RUN pnpm run build

EXPOSE 3000

CMD ["pnpm", "start"]
