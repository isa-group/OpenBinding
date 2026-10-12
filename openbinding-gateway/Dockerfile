FROM python:3.11-slim
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

ENV HTTP_PROXY=$HTTP_PROXY \
    HTTPS_PROXY=$HTTPS_PROXY \
    NO_PROXY=$NO_PROXY \
    http_proxy=$HTTP_PROXY \
    https_proxy=$HTTPS_PROXY \
    no_proxy=$NO_PROXY

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY openbinding-gateway/pyproject.toml .
COPY openbinding-gateway/src/ src/
RUN uv pip install --system ".[test]"

# Migrations. Copied rather than relied on from the bind mount, so that an
# image built for a deployment that does not mount the source still knows how
# to bring its own schema up to date.
COPY openbinding-gateway/alembic.ini .
COPY openbinding-gateway/alembic/ alembic/

# A deployable image owns the exact language contract it serves. Compose may
# still mount these paths while developing, but Kubernetes needs no generated
# ConfigMap or out-of-band copy step.
COPY schemas/ schemas/
COPY examples/ examples/

# Add test runner script
RUN echo '#!/bin/sh\npytest "$@"' > /usr/local/bin/test && \
    chmod +x /usr/local/bin/test

COPY openbinding-gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 8000

# Client addresses come from X-Forwarded-For only when the immediate peer is one
# of FORWARDED_ALLOW_IPS (comma-separated addresses or CIDR networks). The
# default trusts nobody but the container itself, so a client cannot choose the
# address the authentication throttling counts; behind a reverse proxy set it to
# that proxy's network (see docker-compose.yml).
ENV FORWARDED_ALLOW_IPS=127.0.0.1

# Run the application
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "exec uvicorn openbinding_gateway.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips \"${FORWARDED_ALLOW_IPS:-127.0.0.1}\""]
