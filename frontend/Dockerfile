FROM node:20-slim AS base

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

ENV HTTP_PROXY=$HTTP_PROXY \
	HTTPS_PROXY=$HTTPS_PROXY \
	NO_PROXY=$NO_PROXY \
	http_proxy=$HTTP_PROXY \
	https_proxy=$HTTPS_PROXY \
	no_proxy=$NO_PROXY

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

FROM base AS dev
ARG VITE_API_BASE_URL=http://localhost:8000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
EXPOSE 5173
CMD ["pnpm", "dev", "--host", "0.0.0.0", "--port", "5173"]

FROM base AS build
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm run build

FROM nginx:1.27-alpine AS prod-static
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

ENV HTTP_PROXY=$HTTP_PROXY \
	HTTPS_PROXY=$HTTPS_PROXY \
	NO_PROXY=$NO_PROXY \
	http_proxy=$HTTP_PROXY \
	https_proxy=$HTTPS_PROXY \
	no_proxy=$NO_PROXY

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
