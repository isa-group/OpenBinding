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
#: A personal API key (``obk_``) or an environment feed key (``obe_``).
_OPENBINDING_KEY = re.compile(r"\bob[ke]_[A-Za-z0-9_-]+")
#: A SPHERE API key (an organization's connection): never logged, whatever carries it.
_SPHERE_KEY = re.compile(r"\bsk-[0-9a-f]{64}\b")
#: OAuth parameters of a sign-in callback in any URL a message carries. A bare ``code`` label is not masked:
#: closed error codes are logged as ``code=…``.
_OAUTH_QUERY = re.compile(r"([?&](?:code|state|session_state)=)[^&\s\"']+")


def redact(value: str, secrets: Iterable[str] = ()) -> str:
    """Remove common credential forms and explicitly configured secrets."""

    result = value
    for secret in secrets:
        if secret:
            result = result.replace(secret, "[REDACTED]")
    result = _BEARER.sub("Bearer [REDACTED]", result)
    result = _LABELED_SECRET.sub(r"\1\2[REDACTED]", result)
    result = _SPHERE_KEY.sub("[REDACTED]", result)
    result = _OAUTH_QUERY.sub(r"\1[REDACTED]", result)
    return _OPENBINDING_KEY.sub("[REDACTED]", result)


class AuthQueryFilter(logging.Filter):
    """Drop the query string of every ``/v1/auth/`` path from uvicorn's access log, before it is formatted.

    Uvicorn logs the path with its query (``args[2]``), and the sign-in callback's query is an authorization
    code and a state; a password reset may carry a token too.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str) and "/v1/auth/" in args[2]:
            record.args = (*args[:2], args[2].split("?", 1)[0], *args[3:])
        return True


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
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(item, AuthQueryFilter) for item in access.filters):
        access.addFilter(AuthQueryFilter())
