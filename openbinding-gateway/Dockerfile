FROM python:3.11-slim
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy

ENV HTTP_PROXY=$HTTP_PROXY \
    HTTPS_PROXY=$HTTPS_PROXY \
    NO_PROXY=$NO_PROXY \
    http_proxy=$HTTP_PROXY \
    https_proxy=$HTTPS_PROXY \
    no_proxy=$NO_PROXY

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY pyproject.toml .
COPY src/ src/
RUN uv pip install --system ".[test]"

# Add test runner script
RUN echo '#!/bin/sh\npytest "$@"' > /usr/local/bin/test && \
    chmod +x /usr/local/bin/test

# Expose port
EXPOSE 8000

# Run the application
CMD ["uvicorn", "openbinding_gateway.main:app", "--host", "0.0.0.0", "--port", "8000"]
