"""Stable public failures and the correlation id that ties one to its log line.

A 5xx must not explain itself: the text of an exception may quote the input, a
host name or a secret.  The client gets a fixed ``code`` and ``detail`` plus a
``correlationId``; the log gets the exception class, where it was raised and the
same id, and an operator joins the two.  The pattern is the one of
``bim-service`` (``bim_service/middleware.py``).

* :func:`correlation_id` - the id of one request: the trace id of a valid
  ``traceparent`` header, otherwise a random 32-character hex string.
* :func:`internal_error_response` - the answer to an exception nobody handled.
* :class:`CorrelationIdMiddleware` - adds ``correlationId`` to every 5xx JSON
  document, whichever route or handler produced it.  4xx documents are never
  touched.
* :data:`JOB_FAILURES` / :func:`job_failure_fields` - the closed catalog of why a
  job failed: a stable ``code`` and a fixed sentence.  The ``error`` a job shows
  is always one of those sentences, never the text of an exception.
* :func:`log_internal_failure` / :func:`scrub_text` - where the raw reason goes
  instead: the log, with URLs, addresses and host names masked, bounded, next to
  the correlation id.
* :func:`pricing_unavailable_error` / :func:`invalid_subscription_error` - the
  fixed answers for a pricing service (SPACE, SPHERE) that cannot be read.
"""

from __future__ import annotations

import json
import logging
import re
import traceback
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ..models.errors import api_error
from ..models.problem import CORRELATION_ID_KEY, PROBLEM_MEDIA_TYPE, problem_response
from .logging import redact

logger = logging.getLogger(__name__)

#: Where the id of the request lives in ``scope["state"]`` (``request.state.correlation_id``).
STATE_KEY = "correlation_id"

#: W3C trace context: ``version-traceid-parentid-flags``; the all-zero ids and version ``ff`` are invalid.
_TRACEPARENT = re.compile(r"^(?!ff)[0-9a-f]{2}-(?!0{32})([0-9a-f]{32})-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$")

#: A 5xx document larger than this is passed through as it is.
_MAX_REWRITTEN_BODY = 64 * 1024


@dataclass(frozen=True)
class PublicProblem:
    """A failure as the client sees it: the status, a stable code and a fixed sentence."""

    status: int
    code: str
    detail: str


INTERNAL_ERROR = PublicProblem(500, "internal_error", "the service failed to process the request")


def new_correlation_id() -> str:
    return uuid.uuid4().hex


#: The id of the request being served, for code that has no ``Request`` at hand.
_current: ContextVar[str | None] = ContextVar("openbinding_correlation_id", default=None)


def current_correlation_id() -> str:
    """The id of the request being served; a fresh one for work that has no request (a worker, a sweep)."""
    return _current.get() or new_correlation_id()


def correlation_id(scope: Scope) -> str:
    """The id of this request; the same value for every caller within it."""
    state = scope.setdefault("state", {})
    existing = state.get(STATE_KEY)
    if isinstance(existing, str) and existing:
        return existing
    value = None
    for name, raw in scope.get("headers", ()):
        if name.lower() == b"traceparent":
            match = _TRACEPARENT.match(raw.decode("latin-1"))
            if match:
                value = match.group(1)
            break
    value = value or new_correlation_id()
    state[STATE_KEY] = value
    return value


def public_problem_response(
    problem: PublicProblem,
    *,
    correlation_id: str | None = None,
    headers: Mapping[str, str] | None = None,
    media_type: str = PROBLEM_MEDIA_TYPE,
) -> JSONResponse:
    """The problem document of ``problem``; a 5xx should carry the ``correlation_id`` of its log line."""
    extra = {CORRELATION_ID_KEY: correlation_id} if correlation_id else None
    return problem_response(
        problem.status, problem.code, problem.detail, headers=headers, extra=extra, media_type=media_type
    )


def frames(error: BaseException) -> str:
    """``file:function:line`` of the frames of ``error``, innermost last; no source lines, no values."""
    return " > ".join(
        f"{Path(frame.filename).name}:{frame.name}:{frame.lineno}"
        for frame in traceback.extract_tb(error.__traceback__)
    )


def log_unhandled(scope: Scope, error: BaseException, correlation: str) -> None:
    """The class and the frames, never the message: it may quote the input or a secret."""
    logger.error(
        "unhandled %s while serving %s %r correlation_id=%s at %s",
        type(error).__name__,
        scope.get("method"),
        scope.get("path"),
        correlation,
        frames(error),
    )


def internal_error_response(scope: Scope, error: BaseException) -> JSONResponse:
    """What an exception nobody handled becomes: 500 ``internal_error``, fixed text, the correlation id."""
    correlation = correlation_id(scope)
    log_unhandled(scope, error, correlation)
    return public_problem_response(INTERNAL_ERROR, correlation_id=correlation)


# -- The text that is allowed into a log ---------------------------------------

#: Longest piece of an exception's text a log line carries.
MAX_LOGGED_TEXT = 512

#: Where :func:`bounded` cut a text.
TRUNCATION_MARK = "...[truncated]"

_URL = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s'\")>\]]+", re.IGNORECASE)
_HOST_FIELD = re.compile(
    r"(?i)\b(host|hostname|server|endpoint|address|addr)(\s*[=:]\s*)(['\"]?)[^\s,;)'\"]+\3"
)
_IPV6 = re.compile(r"\[[0-9a-f:.]*:[0-9a-f:.]*\](?::\d{1,5})?", re.IGNORECASE)
_IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b")
_HOST_NAME = re.compile(r"\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*\b", re.IGNORECASE)


def bounded(text: str, limit: int) -> str:
    """``text`` cut to ``limit`` characters, the cut marked, so a reader knows it is not whole."""
    if len(text) <= limit:
        return text
    return text[: max(limit - len(TRUNCATION_MARK), 0)] + TRUNCATION_MARK


def scrub_text(text: str, limit: int = MAX_LOGGED_TEXT) -> str:
    """``text`` as a log may carry it: credentials, URLs, addresses and host names masked, then bounded.

    The cut comes first, so that a text that is a megabyte of whatever an engine
    chose to write costs the log a line, not a megabyte.
    """
    value = redact(text[: limit * 4])
    value = _URL.sub("[url]", value)
    value = _HOST_FIELD.sub(lambda match: f"{match.group(1)}{match.group(2)}[host]", value)
    value = _IPV6.sub("[address]", value)
    value = _IPV4.sub("[address]", value)
    value = _HOST_NAME.sub("[host]", value)
    return bounded(value, limit)


def log_internal_failure(
    where: str,
    error: BaseException,
    *,
    correlation: str | None = None,
    level: int = logging.WARNING,
    **context: Any,
) -> str:
    """Log what went wrong inside, for an operator, and return the correlation id of the line.

    The class of the error and of its cause, its text masked and bounded by
    :func:`scrub_text`, where it was raised, and ``context`` (ids and codes the
    gateway chose, never user input).  The public answer carries the same id and
    none of this.
    """
    correlation = correlation or current_correlation_id()
    cause = error.__cause__
    logger.log(
        level,
        "%s failed: %s: %s%s correlation_id=%s%s at %s",
        where,
        type(error).__name__,
        scrub_text(str(error)),
        f" (caused by {type(cause).__name__})" if cause is not None else "",
        correlation,
        "".join(f" {key}={value}" for key, value in context.items()),
        frames(error),
    )
    return correlation


# -- Why a job failed -----------------------------------------------------------

#: Every reason a job can fail for, by stable code, with the sentence its owner reads.
#: A sentence says what kind of failure it was; it never quotes an exception.
JOB_FAILURES: Mapping[str, str] = {
    "engine_unreachable": "The engine could not be reached.",
    "engine_timeout": "The engine did not answer in time.",
    "engine_rejected": "The engine rejected the request.",
    "engine_protocol_error": "The engine answered in a form the gateway cannot accept.",
    "engine_failed": "The engine reported that it could not solve the problem.",
    "engine_endpoint_invalid": "The engine endpoint is not acceptable under the network policy of the gateway.",
    "engine_error": "The request to the engine failed.",
    "credential_unavailable": "The credential for the engine cannot be used.",
    "bim_evaluation_failed": "The answer of the engine could not be evaluated.",
    "job_input_invalid": "The stored request of the job is no longer valid.",
    "registration_changed": "The engine registration changed after the job was submitted.",
    "lease_lost": "The worker running the job was lost.",
    "job_abandoned": "The job was not finished in time and was abandoned.",
    "internal_error": "Internal execution error. The details are in the service log.",
}

#: The code of a failure nobody classified.
UNCLASSIFIED_JOB_FAILURE = "internal_error"

#: The code a :class:`~openbinding_gateway.v1.remote.RemoteEngineError` has unless its raiser says more.
DEFAULT_ENGINE_FAILURE = "engine_error"


def job_failure_fields(code: str, correlation: str) -> dict[str, str]:
    """``error``, ``code`` and ``correlationId`` of a failed job's result; an unknown ``code`` is ``internal_error``."""
    if code not in JOB_FAILURES:
        code = UNCLASSIFIED_JOB_FAILURE
    return {"error": JOB_FAILURES[code], "code": code, "correlationId": correlation}


def classify_job_failure(error: BaseException) -> str:
    """The catalog code of an exception that stopped a job; anything unknown is ``internal_error``.

    Imports are local: the modules that raise these errors import this one.
    """
    import httpx
    from bim_core import BimError

    from ..security.secrets import SecretsUnavailable
    from ..v1.remote import RemoteEngineError

    if isinstance(error, RemoteEngineError):
        return error.code if error.code in JOB_FAILURES else DEFAULT_ENGINE_FAILURE
    if isinstance(error, (httpx.TimeoutException, TimeoutError)):
        return "engine_timeout"
    if isinstance(error, httpx.HTTPError):
        return "engine_unreachable"
    if isinstance(error, BimError):  # the toolchain, whether in process or over its service (BimServiceError)
        return "bim_evaluation_failed"

    if isinstance(error, SecretsUnavailable):
        return "credential_unavailable"
    return UNCLASSIFIED_JOB_FAILURE


# -- Evaluating the kept answer of an engine again --------------------------------

#: Why ``POST /v1/jobs/{id}/reevaluate`` refuses; every sentence is fixed.
JOB_NOT_REEVALUABLE = PublicProblem(
    409,
    "job_not_reevaluable",
    "Only a job that failed with bim_evaluation_failed can be evaluated again.",
)
JOB_IN_STUDY = PublicProblem(
    409, "job_in_study", "The job belongs to a study run; it cannot be evaluated again on its own."
)
JOB_ALREADY_RETRIED = PublicProblem(409, "job_already_retried", "The job has already been retried.")
CANCELLATION_REQUESTED = PublicProblem(
    409, "cancellation_requested", "The job was asked to stop; it cannot be evaluated again."
)
EVIDENCE_EXPIRED = PublicProblem(
    410, "evidence_expired", "The answer of the engine is no longer kept; retry the job to solve it again."
)
BIM_EVALUATION_UNAVAILABLE = PublicProblem(
    503, "bim_evaluation_failed", JOB_FAILURES["bim_evaluation_failed"]
)


# -- A pricing service that cannot be read --------------------------------------

PRICING_UNAVAILABLE = PublicProblem(503, "pricing_unavailable", "The pricing service is unavailable.")
PUBLISHED_PRICING_UNAVAILABLE = PublicProblem(
    503, "pricing_unavailable", "The published pricing is unavailable."
)
INVALID_SUBSCRIPTION = PublicProblem(
    422, "invalid_subscription", "The requested plan or add-ons are not valid for the current pricing."
)


def pricing_unavailable_error(
    error: BaseException,
    *,
    where: str,
    problem: PublicProblem = PRICING_UNAVAILABLE,
    prefix: str = "",
) -> HTTPException:
    """The stable 503 for a pricing service (SPACE, SPHERE) that cannot be read.

    What SPACE or SPHERE said goes to the log, masked, with the id the 503
    carries as ``correlationId``; the response has the code and a fixed sentence
    (after ``prefix``, which the caller writes and which must be fixed too).
    """
    log_internal_failure(where, error)
    return api_error(problem.status, problem.code, f"{prefix}{problem.detail}")


def invalid_subscription_error(error: BaseException, *, where: str) -> HTTPException:
    """The 422 for a plan or add-on selection that SPACE refuses; its reason stays in the log."""
    log_internal_failure(where, error)
    return api_error(INVALID_SUBSCRIPTION.status, INVALID_SUBSCRIPTION.code, INVALID_SUBSCRIPTION.detail)


def _is_json(message: Message) -> bool:
    for name, value in message.get("headers", ()):
        if name.lower() == b"content-type":
            media_type = value.decode("latin-1").split(";", 1)[0].strip().lower()
            return media_type == "application/json" or media_type.endswith("+json")
    return False


def _with_correlation_id(body: bytes, correlation: str) -> bytes:
    """``body`` with the ``correlationId`` member; unchanged unless it is a JSON object without one."""
    try:
        document = json.loads(body)
    except ValueError:
        return body
    if not isinstance(document, dict) or CORRELATION_ID_KEY in document:
        return body
    document[CORRELATION_ID_KEY] = correlation
    return json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class CorrelationIdMiddleware:
    """Adds ``correlationId`` to the JSON body of every 5xx response and logs the pair with the request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        token = _current.set(correlation_id(scope))
        try:
            await self._serve(scope, receive, send)
        finally:
            _current.reset(token)

    async def _serve(self, scope: Scope, receive: Receive, send: Send) -> None:
        held: Message | None = None
        chunks: list[bytes] = []
        size = 0

        async def send_with_correlation(message: Message) -> None:
            nonlocal held, size
            if message["type"] == "http.response.start" and message["status"] >= 500:
                correlation = correlation_id(scope)
                logger.warning(
                    "%d response to %s %r correlation_id=%s",
                    message["status"],
                    scope.get("method"),
                    scope.get("path"),
                    correlation,
                )
                if _is_json(message):
                    held = message
                    return
            elif held is not None and message["type"] == "http.response.body":
                chunk = message.get("body", b"")
                chunks.append(chunk)
                size += len(chunk)
                if message.get("more_body", False) and size <= _MAX_REWRITTEN_BODY:
                    return
                start, held = held, None
                body = b"".join(chunks)
                if not message.get("more_body", False):
                    body = _with_correlation_id(body, correlation_id(scope))
                    message = {**message, "body": body}
                    start["headers"] = list(start.get("headers", ()))
                    MutableHeaders(scope=start)["content-length"] = str(len(body))
                    await send(start)
                    await send(message)
                    return
                # Too large to be one of our documents: send what was held, unchanged.
                await send(start)
                await send({**message, "body": body})
                return
            await send(message)

        await self.app(scope, receive, send_with_correlation)
