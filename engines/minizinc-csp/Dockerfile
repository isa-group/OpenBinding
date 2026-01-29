FROM node:20-slim

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
