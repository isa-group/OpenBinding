FROM node:20-slim as builder

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Set default API URL for Docker deployment (can be overridden)
ENV VITE_API_BASE_URL=http://localhost:8000

RUN pnpm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Create examples directory and make it available to be mounted
RUN mkdir -p /usr/share/nginx/html/examples

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
