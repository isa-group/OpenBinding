FROM python:3.11-slim AS base
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

ENV HTTP_PROXY=$HTTP_PROXY \
    HTTPS_PROXY=$HTTPS_PROXY \
    NO_PROXY=$NO_PROXY \
    http_proxy=$HTTP_PROXY \
    https_proxy=$HTTPS_PROXY \
    no_proxy=$NO_PROXY

# uv is pinned to an explicit release (neither pyproject.toml nor uv.lock records a uv
# version, so this is the reference: 0.8.22). Bump it deliberately, never use :latest.
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /bin/uv

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY openbinding-gateway/pyproject.toml openbinding-gateway/uv.lock ./
COPY openbinding-gateway/src/ src/
COPY tools/fetch_bim_toolchain.py /tmp/fetch_bim_toolchain.py

# The image installs exactly what the lock records, which is what CI installs with
# `uv sync --locked`: every package at its locked version and SHA-256 (--require-hashes).
# The BIM language (bim-core, and bim-client, the port the gateway calls it through) is the
# wheels of a bim-toolchain release, which the lock names as files of .bim-wheels/ with
# the SHA-256 of the release assets; the wheel of bim-core carries the five OMG BPMN XSDs.
# bim-service is a test extra only (the HTTP port's tests run it in process); the gateway
# runs BIM in process.
#
# tools/fetch_bim_toolchain.py downloads those wheels from the release through the GitHub
# API and keeps a file only if its SHA-256 is the lock's. While javiercavlop/bim-toolchain
# is private that needs a token that can read it: the build secret `bim_toolchain_token`
# (compose: `secrets` of the build, from the environment variable BIM_TOOLCHAIN_TOKEN),
# read only by that RUN and never written to a layer.
RUN --mount=type=secret,id=bim_toolchain_token,required=false \
    BIM_TOOLCHAIN_TOKEN="$(cat /run/secrets/bim_toolchain_token 2>/dev/null)" \
    python /tmp/fetch_bim_toolchain.py --wheels --lock uv.lock --into .bim-wheels
RUN uv export --frozen --no-dev --extra test --no-emit-project --format requirements-txt -o /tmp/requirements.txt \
 && uv pip install --system --require-hashes -r /tmp/requirements.txt \
 && uv pip install --system --no-deps . \
 && rm -rf .bim-wheels /tmp/requirements.txt /tmp/fetch_bim_toolchain.py

# Migrations. Copied rather than relied on from the bind mount, so that an
# image built for a deployment that does not mount the source still knows how
# to bring its own schema up to date.
COPY openbinding-gateway/alembic.ini .
COPY openbinding-gateway/alembic/ alembic/

# A deployable image owns the exact language contract it serves. Compose may
# still mount these paths while developing, but the image needs no bind mount
# or out-of-band copy step to run.
COPY schemas/ schemas/
COPY examples/ examples/

# The seed tools travel in the image instead of a bind mount of the host checkout. The
# seed runs as uid 10001, and under rootless Docker a bind-mounted tools/ can be
# unreadable for that uid ("Permission denied" on seed_lab.py). Copied before the
# chmod -R a+rX /app below, so they are world-readable like the rest of the code.
COPY openbinding-gateway/tools/ tools/

# Add test runner script
RUN echo '#!/bin/sh\npytest "$@"' > /usr/local/bin/test && \
    chmod +x /usr/local/bin/test

COPY openbinding-gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The gateway and the worker run as an unprivileged user (fixed UID/GID 10001, no home,
# no login shell). Code, alembic, schemas and examples stay owned by root and world-readable
# but not writable, so the process cannot rewrite what it runs. Being root inside a
# rootless container is not being root on the host, but a non-root user is still the
# practice that limits what a compromised process can do.
#
# The artifact directory is created here, owned by 10001, so that a new named volume
# mounted on it inherits that owner (Docker copies the ownership of the image directory
# into an empty named volume). A volume created by an earlier root-run image keeps its
# old owner and must be recreated or chown'ed once.
RUN groupadd --system --gid 10001 openbinding \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin openbinding \
 && chmod -R a+rX /app \
 && mkdir -p /var/lib/openbinding/artifacts \
 && chown -R 10001:10001 /var/lib/openbinding \
 && chmod 750 /var/lib/openbinding/artifacts

# The PostgreSQL test harness (compose.pgtest.json) builds this stage. It adds only the
# tests on top of base, so the production image below never carries them and the harness
# needs neither a bind mount of the checkout nor root. The tests are made world-readable
# while still root, before USER takes effect.
FROM base AS test
COPY openbinding-gateway/tests/ tests/
RUN chmod -R a+rX /app/tests
USER 10001:10001

# The final stage is the production image: builds without a `target` (docker-compose.yml,
# compose.lab.json) end here. Keep it last.
FROM base AS production

USER 10001:10001

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
