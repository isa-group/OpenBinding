# syntax=docker/dockerfile:1
#
# bim-service image.  The build context is bim-toolchain/ (the root of the future repository):
#
#     docker build -f packages/bim-service/Dockerfile -t bim-service:0.1.0 .
#
# Only bim-core and bim-service are installed, from the context; tests, goldens, corpus, tools and docs are neither
# copied nor present (see .dockerignore).  The tokens are NOT part of the image: mount a file with one or two
# bearer tokens (>= 32 characters each) at /run/secrets/bim_service_tokens, or point BIM_SERVICE_TOKENS_FILE elsewhere.
# Without a valid tokens file the service refuses to start.
#
#     docker run --rm -p 8080:8080 \
#         -v "$PWD/tokens:/run/secrets/bim_service_tokens:ro" bim-service:0.1.0
#
# NOT BUILT: this file was written without access to a Docker daemon.

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BIM_SERVICE_TOKENS_FILE=/run/secrets/bim_service_tokens

# An unprivileged user with no home and no shell.
RUN groupadd --system --gid 10001 bim \
 && useradd --system --uid 10001 --gid bim --no-create-home --shell /usr/sbin/nologin bim

WORKDIR /build

# pyproject.toml names README.md as the readme, so it is copied with it; nothing else of the packages is.
COPY packages/bim-core/pyproject.toml packages/bim-core/README.md packages/bim-core/
COPY packages/bim-core/src packages/bim-core/src
COPY packages/bim-service/pyproject.toml packages/bim-service/README.md packages/bim-service/
COPY packages/bim-service/src packages/bim-service/src

# The licence texts and notices travel with the code (the OMG BPMN schemas inside bim_core keep their own).
COPY LICENSE NOTICE.md THIRD_PARTY_NOTICES.md /usr/share/doc/bim-service/

# One pip invocation, so that bim-service's requirement on bim-core is met by the local copy.
RUN pip install ./packages/bim-core ./packages/bim-service \
 && cd / && rm -rf /build

USER 10001:10001
WORKDIR /home
EXPOSE 8080

# /healthz needs no token and says nothing about the service.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).status == 200 else 1)"]

# The application factory reads BIM_SERVICE_* and fails (non-zero exit) if it cannot authenticate.
# Access logs are off: the service writes one log line per request without query strings, bodies or tokens.
CMD ["uvicorn", "--factory", "bim_service.app:create_app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log", "--timeout-keep-alive", "5"]
