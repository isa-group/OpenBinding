"""Small structured logging setup with defensive secret redaction."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Iterable


_LABELED_SECRET = re.compile(
    r"(?i)(authorization|x-api-key|api[_-]?key|password|secret|token|credential)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
_BEARER = re.compile(r"(?i)\bBearer\s+[^\s,;]+")
_OPENBINDING_KEY = re.compile(r"\bobk_[A-Za-z0-9_-]+")


def redact(value: str, secrets: Iterable[str] = ()) -> str:
    """Remove common credential forms and explicitly configured secrets."""

    result = value
    for secret in secrets:
        if secret:
            result = result.replace(secret, "[REDACTED]")
    result = _BEARER.sub("Bearer [REDACTED]", result)
    result = _LABELED_SECRET.sub(r"\1\2[REDACTED]", result)
    return _OPENBINDING_KEY.sub("[REDACTED]", result)


class JsonFormatter(logging.Formatter):
    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self._secrets = tuple(secret for secret in secrets if secret)

    def format(self, record: logging.LogRecord) -> str:
        document = {
            "timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": redact(record.getMessage(), self._secrets),
        }
        if record.exc_info:
            document["exception"] = redact(self.formatException(record.exc_info), self._secrets)
        return json.dumps(document, ensure_ascii=False, separators=(",", ":"))


def configure_logging(*, level: str = "INFO", secrets: Iterable[str] = ()) -> None:
    """Configure application and Uvicorn loggers with one JSON handler."""

    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter(secrets))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers[:] = [handler]
        logger.propagate = False
