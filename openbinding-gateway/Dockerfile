FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

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
