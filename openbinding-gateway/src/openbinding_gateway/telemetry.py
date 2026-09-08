"""Error diagnostics and telemetry interceptor.

Captures all HTTP error responses (>= 400) and solver job execution failures,
sanitizes sensitive fields, and persists structured ApiErrorEvent records for
administrative visibility and operational diagnostics.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Optional, Tuple

import jwt
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .db import base as db_base
from .db.models import Job, utcnow
from .db.platform_models import ApiErrorEvent

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
    if status_code == 402 or code in ("quota_exceeded", "quota_exhausted"):
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
    if db_base.is_configured():
        return db_base.session_factory()(), True

    try:
        from .access.dependencies import session_dependency
        from .main import app

        override = app.dependency_overrides.get(session_dependency)
        if override:
            gen = override()
            s = await anext(gen)
            engine = getattr(s, "bind", None)
            if engine is not None:
                factory = async_sessionmaker(engine, expire_on_commit=False)
                return factory(), True
    except Exception:
        pass

    return None, False


def _extract_user_id_from_headers(headers: list[tuple[bytes, bytes]]) -> Optional[uuid.UUID]:
    """Attempt extraction of authenticated user id from Authorization header."""
    for key, value in headers:
        if key.lower() == b"authorization":
            try:
                auth_str = value.decode("utf-8")
                if auth_str.lower().startswith("bearer "):
                    token = auth_str[7:].strip()
                    payload = jwt.decode(token, options={"verify_signature": False})
                    sub = payload.get("sub")
                    if sub:
                        return uuid.UUID(str(sub))
            except Exception:
                pass
    return None


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
        headers = scope.get("headers", [])
        user_id = _extract_user_id_from_headers(headers)

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
                                error_code = (
                                    parsed_body.get("title")
                                    or parsed_body.get("detail", {}).get("code")
                                    or parsed_body.get("code")
                                    or error_code
                                )
                        except Exception:
                            parsed_body = {"raw": full_body.decode("utf-8", errors="replace")[:1000]}

                        category = categorize_error(response_status, error_code)
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
