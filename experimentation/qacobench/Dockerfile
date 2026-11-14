FROM python:3.12.9-slim-bookworm@sha256:48a11b7ba705fd53bf15248d1f94d36c39549903c5d59edcfa2f3f84126e7b44
COPY --from=ghcr.io/astral-sh/uv:0.8.22@sha256:9874eb7afe5ca16c363fe80b294fe700e460df29a55532bbfea234a0f12eddb1 /uv /bin/uv
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/workspace/openbinding-gateway/src:/workspace MPLBACKEND=Agg
WORKDIR /workspace
COPY openbinding-gateway/ openbinding-gateway/
COPY schemas/ schemas/
COPY experimentation/qacobench/ experimentation/qacobench/
COPY datasets/scripts/transform_*.py datasets/scripts/write_benchmark_metadata.py transformations/scripts/
# The BIM language (bim-core, and bim-client, the port the gateway calls it through) is the pair of wheels of the
# bim-toolchain release in bim-toolchain.txt (the files and SHA-256 openbinding-gateway/uv.lock pins), installed in the
# same command as ./openbinding-gateway of requirements.lock so that they satisfy its requirements by name
# (--no-sources: the gateway's [tool.uv.sources] are not read). tools/fetch_bim_toolchain.py downloads them from the
# release, each checked against the lock; while javiercavlop/bim-toolchain is private it reads the build secret
# bim_toolchain_token, in that RUN only.
COPY tools/fetch_bim_toolchain.py /tmp/fetch_bim_toolchain.py
RUN --mount=type=secret,id=bim_toolchain_token,required=false \
    BIM_TOOLCHAIN_TOKEN="$(cat /run/secrets/bim_toolchain_token 2>/dev/null)" \
    python /tmp/fetch_bim_toolchain.py --wheels --lock openbinding-gateway/uv.lock --into .bim-wheels
RUN uv pip install --system --no-sources -r experimentation/qacobench/requirements.lock \
      -r experimentation/qacobench/bim-toolchain.txt \
 && rm -rf .bim-wheels /tmp/fetch_bim_toolchain.py
RUN mkdir -p datasets .artifacts/qacobench
CMD ["python", "experimentation/qacobench/campaign.py", "--help"]
