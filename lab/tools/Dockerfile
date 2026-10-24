# Image of the SPACE lab bootstrap tool. Build context: the repository root.
# The python digest is a medium-confidence Docker Hub lookup of 24-10-2026 and was not built by the worker;
# a wrong digest fails the build loudly. Transitive pins are exact versions without hashes.
FROM python:3.12.8-slim-bookworm@sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0
WORKDIR /app
COPY lab/tools/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY lab/tools/space_lab_bootstrap.py ./space_lab_bootstrap.py
USER 1000:1000
ENTRYPOINT ["python", "/app/space_lab_bootstrap.py"]
