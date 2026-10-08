FROM python:3.12.9-slim-bookworm@sha256:48a11b7ba705fd53bf15248d1f94d36c39549903c5d59edcfa2f3f84126e7b44
COPY --from=ghcr.io/astral-sh/uv:0.8.22@sha256:9874eb7afe5ca16c363fe80b294fe700e460df29a55532bbfea234a0f12eddb1 /uv /bin/uv
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/workspace/openbinding-gateway/src:/workspace MPLBACKEND=Agg
WORKDIR /workspace
COPY openbinding-gateway/ openbinding-gateway/
COPY schemas/ schemas/
COPY space/pricing/openbinding.yml space/pricing/openbinding.yml
COPY experimentation/qacobench/ experimentation/qacobench/
COPY datasets/scripts/transform_*.py transformations/scripts/
RUN uv pip install --system -r experimentation/qacobench/requirements.lock
RUN mkdir -p datasets .artifacts/qacobench
CMD ["python", "experimentation/qacobench/campaign.py", "--help"]
