"""Error diagnostics and telemetry interceptor.

Captures all HTTP error responses (>= 400) and solver job execution failures,
sanitizes sensitive fields, and persists structured ApiErrorEvent records for
administrative visibility and operational diagnostics.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections import deque
from datetime import timedelta
from typing import Any, Optional, Tuple

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .core.settings import get_settings
from .db import base as db_base
from .db.models import Job, utcnow
from .db.platform_models import ApiErrorEvent
from .domain import binding_space, usage_counters

logger = logging.getLogger(__name__)

SENSITIVE_KEYS = {
    "password",
    "token",
    "secret",
    "authorization",
    "api_key",
    "access_token",
    "refresh_token",
    "credential",
    "private_key",
    "client_secret",
    "secret_hash",
    "password_hash",
}

SENSITIVE_PATHS = (
    "/v1/auth/login",
    "/v1/auth/register",
    "/v1/auth/reset-password",
    "/v1/auth/change-password",
)


def sanitize_detail(data: Any, path: str = "") -> Any:
    """Recursively redact secrets and omit user inputs on auth endpoints."""
    if any(path.startswith(p) for p in SENSITIVE_PATHS) or "login" in path or "register" in path:
        if isinstance(data, dict):
            return {
                k: sanitize_detail(v, path)
                for k, v in data.items()
                if k in ("code", "error", "message", "title", "status", "type", "diagnostics")
            }
    if isinstance(data, dict):
        sanitized = {}
        for k, v in data.items():
            key_lower = str(k).lower()
            if key_lower in SENSITIVE_KEYS or any(s in key_lower for s in ("password", "secret", "token")):
                sanitized[k] = "[REDACTED]"
            else:
                sanitized[k] = sanitize_detail(v, path)
        return sanitized
    if isinstance(data, list):
        return [sanitize_detail(item, path) for item in data]
    return data


def categorize_error(status_code: int, code: str) -> str:
    """Map status codes and machine error codes to business diagnostics categories."""
    if (
        status_code == 402
        or code in ("quota_exceeded", "quota_exhausted", usage_counters.UNKNOWN_CODE)
        or code in binding_space.REFUSAL_CODES
    ):
        return "pricing_quota"
    if status_code == 429 or code in ("concurrency_limit_exceeded", "rate_limit_exceeded"):
        return "concurrency"
    if code in ("solver_crashed", "solver_timeout", "solver_oom", "solver_failure"):
        return "solver_failure"
    if status_code in (401, 403) or code in ("unauthorized", "forbidden", "feature_not_entitled", "invalid_token"):
        return "auth"
    if status_code in (400, 422, 413, 415) or "validation" in code or code.startswith("invalid_") or code == "payload_too_large":
        return "validation"
    if status_code >= 500:
        return "system_bug"
    return "system_bug"


async def _get_db_session() -> Tuple[Optional[AsyncSession], bool]:
    """Retrieve an async session from either engine pool or test dependency override."""
    try:
        from .access.dependencies import session_dependency
        from .main import app

        override = app.dependency_overrides.get(session_dependency)
        if override:
            gen = override()
            s = await anext(gen)
            # An overridden request may keep its rows uncommitted (notably
            # transactional tests). A second connection would block on their
            # foreign keys. Borrow the override without committing or closing it.
            return s, False
    except Exception:
        pass

    if db_base.is_configured():
        return db_base.session_factory()(), True
    return None, False


_WINDOW_S = 60.0
_MAX_TRACKED_CLIENTS = 10_000
_anonymous_hits: dict[str, deque[float]] = {}


def reset_anonymous_error_limits() -> None:
    _anonymous_hits.clear()


def _admit_anonymous_error(client: str) -> bool:
    """Whether one more anonymous 401/404 from ``client`` may be persisted."""
    limit = get_settings().anonymous_error_events_per_minute
    if limit <= 0:
        return True
    now = time.monotonic()
    window = _anonymous_hits.setdefault(client, deque())
    while window and now - window[0] >= _WINDOW_S:
        window.popleft()
    admitted = len(window) < limit
    if admitted:
        window.append(now)
    if len(_anonymous_hits) > _MAX_TRACKED_CLIENTS:
        for key in [k for k, v in _anonymous_hits.items() if not v or now - v[-1] >= _WINDOW_S]:
            del _anonymous_hits[key]
        # Every tracked client may still be active: drop the least recent ones
        # so the table never grows past its bound.
        excess = len(_anonymous_hits) - _MAX_TRACKED_CLIENTS
        if excess > 0:
            for key in sorted(_anonymous_hits, key=lambda k: _anonymous_hits[k][-1])[:excess]:
                del _anonymous_hits[key]
    return admitted


async def purge_old_error_events(session: AsyncSession, days: int = 90) -> int:
    """Delete error events older than ``days``; returns how many were removed."""
    cutoff = utcnow() - timedelta(days=days)
    result = await session.execute(delete(ApiErrorEvent).where(ApiErrorEvent.created_at < cutoff))
    return result.rowcount or 0


async def record_api_error(
    *,
    status_code: int,
    endpoint: str,
    http_method: str,
    error_code: str,
    category: str,
    detail: dict,
    user_id: Optional[uuid.UUID] = None,
    organization_id: Optional[uuid.UUID] = None,
    session: Optional[AsyncSession] = None,
) -> Optional[ApiErrorEvent]:
    """Persist an ApiErrorEvent record."""
    sanitized = sanitize_detail(detail, endpoint)
    event = ApiErrorEvent(
        id=uuid.uuid4(),
        user_id=user_id,
        organization_id=organization_id,
        status_code=status_code,
        category=category,
        error_code=error_code,
        endpoint=endpoint[:256],
        http_method=http_method[:10],
        detail=sanitized if isinstance(sanitized, dict) else {"raw": sanitized},
        created_at=utcnow(),
    )

    if session is not None:
        session.add(event)
        return event

    db_session, should_close = await _get_db_session()
    if db_session is None:
        return None

    try:
        db_session.add(event)
        if not should_close:
            return event
        await db_session.commit()
        return event
    except Exception as exc:
        logger.debug("Telemetry error write failed: %s", exc)
        await db_session.rollback()
        return None
    finally:
        if should_close:
            await db_session.close()


async def record_job_failure(
    session: AsyncSession,
    job: Job,
    reason: str | None = None,
) -> Optional[ApiErrorEvent]:
    """Hook called when a Job transitions to JobState.FAILED."""
    return await record_api_error(
        status_code=500,
        endpoint=f"/v1/jobs/{job.id}",
        http_method="POST",
        error_code="solver_crashed",
        category="solver_failure",
        detail={
            "job_id": str(job.id),
            "engine_id": job.engine_id,
            "error": reason or "Solver job failed",
            "state": "failed",
        },
        user_id=job.owner_id,
        organization_id=job.organization_id,
        session=session,
    )


class ErrorTelemetryMiddleware:
    """ASGI middleware capturing >= 400 responses into ApiErrorEvent."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        endpoint = scope.get("path", "")
        method = scope.get("method", "GET")
        client = (scope.get("client") or ("unknown",))[0]
        # Request.state writes into scope["state"]; creating it here guarantees
        # the dependencies and this middleware share the same dict.
        state = scope.setdefault("state", {})

        response_status = 200
        body_chunks: list[bytes] = []

        async def send_wrapper(message: Message) -> None:
            nonlocal response_status
            if message["type"] == "http.response.start":
                response_status = message["status"]
            elif message["type"] == "http.response.body":
                if response_status >= 400:
                    body_chunks.append(message.get("body", b""))
                    if not message.get("more_body", False):
                        full_body = b"".join(body_chunks)
                        parsed_body: dict = {}
                        error_code = f"http_{response_status}"
                        try:
                            decoded = full_body.decode("utf-8")
                            parsed_body = json.loads(decoded)
                            if isinstance(parsed_body, dict):
                                nested = parsed_body.get("detail")
                                error_code = (
                                    parsed_body.get("title")
                                    or (nested.get("code") if isinstance(nested, dict) else None)
                                    or parsed_body.get("code")
                                    or error_code
                                )
                        except Exception:
                            parsed_body = {"raw": full_body.decode("utf-8", errors="replace")[:1000]}

                        category = categorize_error(response_status, error_code)
                        user_id = state.get("user_id")
                        if not isinstance(user_id, uuid.UUID):
                            user_id = None
                        if (
                            user_id is None
                            and response_status in (401, 404)
                            and not _admit_anonymous_error(client)
                        ):
                            await send(message)
                            return
                        try:
                            await record_api_error(
                                status_code=response_status,
                                endpoint=endpoint,
                                http_method=method,
                                error_code=error_code,
                                category=category,
                                detail=parsed_body,
                                user_id=user_id,
                            )
                        except Exception as exc:
                            logger.debug("Failed recording error in telemetry middleware: %s", exc)

            await send(message)

        await self.app(scope, receive, send_wrapper)
