FROM node:20-slim

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Install MiniZinc + healthcheck tooling
RUN apt-get update && apt-get install -y --no-install-recommends minizinc curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
COPY tsconfig.json .
RUN pnpm install

COPY src/ src/
COPY model/ model/
RUN pnpm run build

EXPOSE 3000

CMD ["pnpm", "start"]
