FROM python:3.12.9-slim-bookworm@sha256:48a11b7ba705fd53bf15248d1f94d36c39549903c5d59edcfa2f3f84126e7b44
COPY --from=ghcr.io/astral-sh/uv:0.8.22@sha256:9874eb7afe5ca16c363fe80b294fe700e460df29a55532bbfea234a0f12eddb1 /uv /bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app/src SCHEMAS_DIR=/app/schemas
WORKDIR /app
COPY experimentation/qacobench/gateway.lock /tmp/gateway.lock
RUN uv pip install --system -r /tmp/gateway.lock
COPY openbinding-gateway/pyproject.toml openbinding-gateway/uv.lock ./
COPY openbinding-gateway/src/ src/
COPY experimentation/qacobench/bim-toolchain.txt /tmp/bim-toolchain.txt
COPY tools/fetch_bim_toolchain.py /tmp/fetch_bim_toolchain.py
# The BIM language the gateway compiles and evaluates with (bim-core) and the port it calls it through (bim-client):
# the wheels of the bim-toolchain release in bim-toolchain.txt (the files and SHA-256 openbinding-gateway/uv.lock pins);
# their dependencies are in gateway.lock. tools/fetch_bim_toolchain.py downloads them from the release, each checked
# against the lock; while javiercavlop/bim-toolchain is private it reads the build secret bim_toolchain_token, in that
# RUN only.
RUN --mount=type=secret,id=bim_toolchain_token,required=false \
    BIM_TOOLCHAIN_TOKEN="$(cat /run/secrets/bim_toolchain_token 2>/dev/null)" \
    python /tmp/fetch_bim_toolchain.py --wheels --lock uv.lock --into .bim-wheels
RUN uv pip install --system --no-deps --no-sources -r /tmp/bim-toolchain.txt . \
 && rm -rf .bim-wheels /tmp/bim-toolchain.txt /tmp/fetch_bim_toolchain.py
COPY openbinding-gateway/alembic.ini .
COPY openbinding-gateway/alembic/ alembic/
COPY openbinding-gateway/tools/ tools/
COPY experimentation/qacobench/seed_engines.py benchmark/seed_engines.py
COPY schemas/ schemas/
COPY examples/ examples/
COPY openbinding-gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["uvicorn", "openbinding_gateway.main:app", "--host", "0.0.0.0", "--port", "8000"]
