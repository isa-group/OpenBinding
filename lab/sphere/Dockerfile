# The lab's SPHERE stand-in (compose.lab.json service sphere-lab): openbinding-gateway/tools/sphere_lab.py serving the
# recorded SPHERE answers and the synthetic scenarios of openbinding-gateway/tests/fixtures/sphere. Standard library
# only, so nothing is installed; built from the repository root (the root .dockerignore admits openbinding-gateway/).
# The recorded pricings are test data (see the fixtures README): this image is built locally and never published.
FROM python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SPHERE_LAB_FIXTURES=/app/fixtures/sphere \
    SPHERE_LAB_STATE=/state

WORKDIR /app
COPY openbinding-gateway/tests/fixtures/sphere/ fixtures/sphere/
COPY openbinding-gateway/tools/sphere_lab.py sphere_lab.py
# The lab-sphere volume is seeded from this directory on first use, so it is owned by the unprivileged user.
RUN mkdir /state && chown 10001:10001 /state

USER 10001
EXPOSE 8080 8081
CMD ["python", "/app/sphere_lab.py"]
