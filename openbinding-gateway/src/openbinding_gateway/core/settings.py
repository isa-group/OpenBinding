"""Every knob the gateway reads from the environment, in one place.

Configuration used to be a scattering of ``os.getenv`` calls: the CORS rule in
``main``, engine endpoints, request limits, and schema paths each had a
different default.
Nothing was wrong with any one of them, but there was no way to answer "what can
be configured?" short of grepping, and a user module adding a database URL, a
signing secret and a SPACE endpoint is exactly the point where that stops being
tenable.

The values keep their historical names. The one default that changed is CORS,
which is now a closed list of local development origins instead of ``*``; a
production deployment (``APP_ENV=prod``) must name its origins, and an empty or
wildcard list stops the process at startup, and so does a malformed public
origin (``PUBLIC_BASE_URL``, ``FRONTEND_URL``, a CORS entry), which a browser
would otherwise ignore without a word. Two rules that used to live at their
call sites now live here, where they can be stated once: the
wildcard-versus-credentials rule for CORS, and the fact that a schema path from
the environment is only a preference, not a promise that the file exists.
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from typing import List, Literal, Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: The only origins allowed by default: the frontend's Vite dev server (5173)
#: and the Playwright test server (4177), by name and by loopback address.
DEV_CORS_ORIGINS = (
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:4177,http://127.0.0.1:4177"
)

#: Response headers a browser may read from a cross-origin response. Without
#: this list only the CORS-safelisted ones are visible, and the client's 429
#: countdown (``Retry-After``) never appears. Only headers the API really sets
#: or uses are listed: ``Retry-After`` (429/503), ``ETag`` (content-addressed
#: downloads), ``Location`` (redirects), ``Content-Disposition`` and ``Digest``
#: (archive downloads), and ``Idempotency-Key`` (job submission).
CORS_EXPOSED_HEADERS = (
    "Retry-After",
    "ETag",
    "Location",
    "Content-Disposition",
    "Digest",
    "Idempotency-Key",
    "X-Total-Count",
)


#: Shortest accepted ``GATEWAY_JWT_SECRET`` outside ``APP_ENV=test``.
MIN_JWT_SECRET_LENGTH = 32

#: Default ``iss`` and ``aud`` of the gateway's session tokens.
DEFAULT_JWT_ISSUER = "openbinding-gateway"

#: The production SPACE service, and the default of ``SPACE_SERVICE_NAME``.
DEFAULT_SPACE_SERVICE_NAME = "openbinding"

#: Shape of a SPACE service name (``SPACE_SERVICE_NAME``).
SPACE_SERVICE_NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{1,62}")


#: The public SPHERE (``SPHERE_URL``'s default).
DEFAULT_SPHERE_URL = "https://sphere.score.us.es"

#: A SPHERE registry alias: the pattern a Composition2Yaml ``registry:`` names one by
#: (``composition/ids.py`` ``ALIAS``; a test keeps the two the same).
SPHERE_REGISTRY_ALIAS = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")


class SphereRegistry(BaseModel):
    """One on-premise SPHERE a document may name by its alias (``registry: <alias>``).

    The pricing source (``modules/plans``) reads it at its address with its key. The
    key is a ``SecretStr``, so neither ``repr`` nor a log line shows it, and neither the
    address nor the key ever reaches a response.
    """

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    url: HttpUrl
    api_key: Optional[SecretStr] = None

    @field_validator("url")
    @classmethod
    def https_only(cls, url: HttpUrl) -> HttpUrl:
        if url.scheme != "https":
            raise ValueError("a SPHERE registry is reached over https only")
        return url


def _mask_userinfo(value: str) -> str:
    """``value`` with everything between ``://`` (or the start) and its last ``@`` replaced by ``***``."""
    head, at, tail = value.rpartition("@")
    if not at:
        return value
    scheme_end = head.find("://")
    prefix = head[: scheme_end + 3] if scheme_end >= 0 else ""
    return f"{prefix}***@{tail}"


#: Host of an origin: a name, or a bracketed IPv6 literal.
HOST_PATTERN = re.compile(r"[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]")


def _require_origin(name: str, value: str, *, trailing_slash: bool) -> None:
    """Raise unless ``value`` is ``http(s)://host[:port]``, naming ``name`` if not.

    No path, query, fragment, userinfo, wildcard, comma or whitespace; a single
    trailing ``/`` only when ``trailing_slash`` is true.
    """
    body = value[:-1] if trailing_slash and value.endswith("/") else value
    try:
        parts = urlsplit(body)
        port = parts.port  # raises ValueError for a port that is not a number in range
        netloc = parts.netloc
        host = netloc[: netloc.index("]") + 1] if netloc.startswith("[") and "]" in netloc else netloc.split(":")[0]
        valid = (
            parts.scheme in ("http", "https")
            and bool(HOST_PATTERN.fullmatch(host))
            and port != 0
            and not netloc.endswith(":")
            and (netloc.startswith("[") or netloc.count(":") <= 1)
            and (not netloc.startswith("[") or re.fullmatch(r"(:[0-9]+)?", netloc[netloc.index("]") + 1 :]) is not None)
            and "@" not in netloc
            and not parts.path
            and not parts.query
            and not parts.fragment
            and not re.search(r"[\s*,?#]", body)
        )
    except ValueError:
        valid = False
    if not valid:
        slash = " (one trailing '/' is tolerated)" if trailing_slash else " (no trailing '/')"
        raise ValueError(
            f"{name} has an invalid value {_mask_userinfo(value)!r}: expected scheme://host[:port] with an http or "
            f"https scheme, no path, query, fragment, userinfo, '*', comma or space{slash}, "
            "for example https://openbinding.example.org."
        )


#: The path every Identity callback URL ends in; the login route is its sibling ``…/login``.
IDENTITY_CALLBACK_PATH = "/v1/auth/identity/callback"

#: Hosts on which an Identity URL may use plain http (development and labs).
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def _realm_of(url: str) -> Optional[str]:
    match = re.search(r"/realms/([^/]+)$", urlsplit(url).path)
    return match[1] if match else None


def _identity_url(name: str, value: Optional[str]) -> str:
    """``value`` when it is an https URL, or http on a loopback host, with no userinfo, query, fragment or
    trailing '/'; raise naming ``name`` otherwise (port of SPHERE's ``publicUrl``)."""
    if not value or not value.strip():
        raise ValueError(f"{name} is required when AUTH_PROVIDER=scoretech.")
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        parts.port  # noqa: B018 - raises ValueError for a port out of range
    except ValueError as error:
        raise ValueError(f"{name} is not a valid URL.") from error
    secure = parts.scheme == "https" or (parts.scheme == "http" and host in LOOPBACK_HOSTS)
    if (
        not host
        or not secure
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or "?" in value
        or "#" in value
        or value.endswith("/")
        or re.search(r"\s", value)
    ):
        raise ValueError(
            f"{name} must be an https URL (http only on localhost, 127.0.0.1 or [::1]) with no userinfo, "
            "query, fragment or trailing '/'."
        )
    return value


def _fernet_available(keys: Optional[str], legacy: Optional[str]) -> bool:
    """Whether the credential store (``security.secrets.CredentialStore``) would hold at least one valid key."""
    from cryptography.fernet import Fernet

    candidates = [item.strip() for item in (keys or "").split(",") if item.strip()]
    if (legacy or "").strip():
        candidates.append(legacy.strip())
    if not candidates:
        return False
    try:
        for key in candidates:
            Fernet(key.encode("utf-8"))
    except (ValueError, TypeError):
        return False
    return True


class Settings(BaseSettings):
    """The gateway's configuration, read from the environment once."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        # The process environment carries far more than this class describes,
        # and a stray variable is not a configuration error.
        extra="ignore",
        # A validation error would otherwise echo every input, secrets included.
        hide_input_in_errors=True,
    )

    app_env: Literal["dev", "test", "prod"] = "dev"

    # -- Engines ---------------------------------------------------------
    # The defaults are the compose service names, so these only need setting
    # when the gateway runs outside the stack.
    # Federated deployments do not belong here; their endpoints are immutable
    # EngineRegistration revisions persisted through the public API.
    engine_minizinc_url: str = "http://engine-minizinc:3000"
    engine_random_search_url: str = "http://engine-random-search:8080"
    engine_many_heuristic_url: str = "http://engine-many-heuristic:8080"
    engine_evolutionary_heuristics_url: str = "http://engine-evolutionary-heuristics:8080"

    #: How long the gateway waits for an engine before giving up. Note that
    #: nginx has its own read timeout in front of this one; the two are meant
    #: to be kept in step, with nginx's the larger of the two.
    engine_solve_timeout_s: float = 1800.0
    #: Queued plus running jobs one account may have at once; a creation past it
    #: is refused with 429 ``concurrency_limit_exceeded``. A technical limit
    #: that protects the engines, independent of the plan
    #: (``MAX_CONCURRENT_JOBS_PER_USER``).
    max_concurrent_jobs_per_user: int = Field(default=8, ge=1)
    #: Ceiling, in log10 units, on the binding space (the estimated number of
    #: candidate combinations) of one job or study cell (``MAX_BINDING_SPACE_LOG10``).
    #: A setting of the deployment, not a plan entitlement: pricing 0.2.0 has no
    #: size limit. See ``domain/binding_space.py``.
    max_binding_space_log10: float = Field(default=20.0, ge=0, allow_inf_nan=False)
    #: Technical ceiling on the cells (jobs) one study run expands to; ``None``
    #: sets none (``MAX_CELLS_PER_STUDY_RUN``). The plan's ``maxStudyCells``
    #: applies too, and the lower of the two decides; a run over it is refused
    #: whole with 422 ``study_run_too_large`` before anything is written.
    max_cells_per_study_run: Optional[int] = Field(default=None, ge=1)
    #: Ceiling on the effort options of one job (``iterations``,
    #: ``max_evaluations``): a request above it is brought down to it and told so
    #: (``MAX_ITERATIONS``). A setting of the deployment, not a plan entitlement.
    max_iterations: int = Field(default=1_000_000, ge=1)
    #: How long a job may wait in the queue without a worker claiming it before
    #: the reconciler fails it with ``queue_timeout``. Counts from the moment the
    #: job was queued, whatever budget it was given to run
    #: (``QUEUE_TIMEOUT_S``).
    queue_timeout_s: float = Field(default=1800.0, ge=60.0)
    #: Days the raw answer of an engine is kept when BIM could not evaluate it,
    #: so the evaluation can be retried without solving again; the reconciler
    #: deletes it after that (``EVIDENCE_RETENTION_DAYS``). At most 90.
    evidence_retention_days: int = Field(default=14, ge=1, le=90)
    #: Best-effort cancellation of the remote job of an attempt that lost its
    #: lease. A cancellation that must wait (the newer attempt has not yet
    #: registered an id, so cancelling could hit the running one) is deferred at
    #: most this many times and then skipped (``REMOTE_CANCEL_DEFER_LIMIT``).
    remote_cancel_defer_limit: int = Field(default=5, ge=1, le=100)
    #: Claims of one cancellation in all, deferrals included; past it a
    #: cancellation that keeps failing is given up (``REMOTE_CANCEL_MAX_ATTEMPTS``).
    remote_cancel_max_attempts: int = Field(default=8, ge=1, le=100)
    #: Cancellations one reconciler cycle sends at most, and how many at once
    #: (``REMOTE_CANCEL_BATCH``, ``REMOTE_CANCEL_CONCURRENCY``).
    remote_cancel_batch: int = Field(default=20, ge=1, le=500)
    remote_cancel_concurrency: int = Field(default=4, ge=1, le=32)

    # -- v1 schemas ------------------------------------------------------
    #: Directory holding the BIM v1 schemas and manifests.
    schemas_dir: str = "/app/schemas"

    # -- CORS ------------------------------------------------------------
    #: Comma-separated browser origins allowed to call the API: a closed list.
    #: The default is only the local development origins of the frontend (Vite
    #: dev server and the Playwright server), because sign-in is same-origin (the
    #: session cookie and the routes that read it serve the frontend's origin) and
    #: a wildcard would let any site read the API as the signed-in user. In ``APP_ENV=prod`` an empty list or a
    #: ``*`` entry is refused at startup (see ``closed_cors_in_production``).
    #: Every entry must be scheme://host[:port] exactly as a browser sends it in
    #: ``Origin`` (no path, no trailing /, no * inside an entry, lower-case,
    #: default port omitted); a malformed one stops the process (see
    #: ``well_formed_public_origins``). Entries are compared as exact strings, so
    #: a non-canonical one is accepted but never matches.
    cors_allow_origins: str = DEV_CORS_ORIGINS
    cors_allow_credentials: bool = True

    # -- Database --------------------------------------------------------
    #: Async SQLAlchemy URL. The gateway runs without a database until the
    #: user module needs one, which is why this is optional.
    database_url: Optional[str] = None

    # -- Authentication --------------------------------------------------
    #: Signing key for the gateway's own session tokens. Must be set before
    #: authentication is switched on; there is deliberately no default, so a
    #: deployment cannot accidentally ship a well-known secret. Outside
    #: ``APP_ENV=test`` a value shorter than ``MIN_JWT_SECRET_LENGTH`` is refused
    #: at startup, and ``APP_ENV=prod`` refuses to start without one.
    gateway_jwt_secret: Optional[str] = None
    #: Lifetime of a gateway access token (``ACCESS_TOKEN_TTL_S``). The browser keeps it in memory and renews it
    #: from its session cookie (``POST /v1/auth/identity/session``) before it ends.
    access_token_ttl_s: int = 5 * 60
    #: ``iss`` and ``aud`` of the session tokens (``GATEWAY_JWT_ISSUER`` /
    #: ``GATEWAY_JWT_AUDIENCE``). Both are written when a token is issued and
    #: verified when it is read.
    gateway_jwt_issuer: str = Field(default=DEFAULT_JWT_ISSUER, min_length=1)
    gateway_jwt_audience: str = Field(default=DEFAULT_JWT_ISSUER, min_length=1)

    # -- Request bodies --------------------------------------------------
    #: Hard ceiling for any request body, checked by the ASGI body-limit
    #: middleware before the body is buffered (``Content-Length``) and while it
    #: streams (chunked bodies). It is the ceiling of the artifact and package
    #: upload routes, which keep their own, tighter, per-plan checks behind it;
    #: it equals nginx's ``client_max_body_size``.
    max_request_body_bytes: int = Field(default=512 * 1024 * 1024, ge=1)
    #: Ceiling for every other route (JSON documents, registrations, options).
    #: Never above ``max_request_body_bytes``.
    max_json_body_bytes: int = Field(default=16 * 1024 * 1024, ge=1)
    #: Largest BIM package one request may carry, for a solve or an upload
    #: (``MAX_PACKAGE_BYTES``); a larger one is refused with 413
    #: ``payload_too_large``. Never more than ``max_request_body_bytes`` in
    #: effect. A setting of the deployment, not a plan entitlement.
    max_package_bytes: int = Field(default=128 * 1024 * 1024, ge=1)

    # -- Throttling of authentication ------------------------------------
    #: Fixed-window limits for login, registration and refresh
    #: (``core/ratelimit.py``). ``0`` switches a limit off. A key is the client
    #: address plus the identifier being attacked; the address alone has a
    #: ``AUTH_RATE_LIMIT_IP_MULTIPLIER`` times larger budget so that one source
    #: cannot spray many identifiers.
    auth_rate_limit_window_s: int = Field(default=300, ge=1)
    auth_rate_limit_login_attempts: int = Field(default=10, ge=0)
    auth_rate_limit_register_attempts: int = Field(default=5, ge=0)
    auth_rate_limit_refresh_attempts: int = Field(default=30, ge=0)
    auth_rate_limit_ip_multiplier: int = Field(default=10, ge=1)
    #: Seconds the Redis backend is left alone after it failed, so that an
    #: outage costs one timeout per period rather than one per login. The
    #: limiter of the open routes below follows the same period.
    auth_rate_limit_redis_retry_s: float = Field(default=15.0, gt=0)

    # -- Throttling of the work anybody may ask for ----------------------
    #: Requests per window that one client may send to the routes open to
    #: anybody that do real CPU work (``access/work_limits.py`` names them and
    #: docs/ACCESS_POLICY.md explains them). A client is its address (its /64
    #: for IPv6) or, signed in, its account. The class ``compile`` runs the
    #: container's compiler. ``0`` switches a class off for everybody. Counted like
    #: authentication: in Redis, or per process while Redis does not answer.
    work_rate_limit_window_s: int = Field(default=60, ge=1)
    work_rate_limit_compile_requests: int = Field(default=10, ge=0)
    #: The class ``read``: the stateless Composition2Yaml services (validate,
    #: parse, serialise, diff), which an editor calls as its author types, so its
    #: budget is larger.
    work_rate_limit_read_requests: int = Field(default=60, ge=0)
    #: The class ``evaluate``: sealing or checking a composition version, which
    #: has the toolchain evaluate its binding (and compile its problem on a miss).
    work_rate_limit_evaluate_requests: int = Field(default=30, ge=0)
    #: How many times that budget a signed-in caller gets.
    work_rate_limit_signed_in_multiplier: int = Field(default=5, ge=1)

    # -- Composition environments ---------------------------------------
    #: How many environments a composition may have (``COMPOSITION_ENVIRONMENTS_MAX``). Pricing 0.2.0 has no
    #: limit for them; ``maxEnvironments`` replaces this setting with pricing 0.3.0.
    composition_environments_max: int = Field(default=5, ge=1)
    #: Reads of an environment's feed per minute per credential (a feed key, or a member) (``FEED_RATE_PER_MINUTE``);
    #: 0 switches the limit off. A consumer polls every 30 s.
    feed_rate_per_minute: int = Field(default=60, ge=0)

    # -- The first administrator -----------------------------------------
    #: Registration is open and produces ordinary users, so a fresh deployment
    #: has no administrator and no way to acquire one - promoting an account is
    #: itself an administrator's privilege. These seed or promote the first.
    #: Ignored once any administrator exists.
    bootstrap_admin_username: Optional[str] = None
    bootstrap_admin_email: Optional[str] = None
    bootstrap_admin_password: Optional[str] = None
    #: Plan the bootstrap administrator is contracted on. The backend names no
    #: commercial plan: unset, the administrator is created without one and SPACE
    #: assigns it (``SPACE_DEFAULT_PLAN`` applies to ordinary sign-ups only).
    bootstrap_admin_plan: Optional[str] = None
    #: Opt-in to seeding an ``admin`` account in a database with no accounts at
    #: all. It needs a password from the operator (``BOOTSTRAP_ADMIN_PASSWORD``);
    #: nothing is ever seeded with a built-in one, whatever ``APP_ENV`` says.
    seed_default_admin: bool = False

    # -- SPACE (pricing-driven access control) ---------------------------
    #: SPACE and SPHERE own pricings, versions, plans and contracts and are
    #: administered in their own consoles. The gateway only creates the user's
    #: contract, changes its plan and reads what it allows, through SPACE's
    #: official client.
    #: ``SPACE_ENABLED=false`` builds a stateless open gate (every functional
    #: capability granted, no plans, no counters). It exists for development and
    #: QacoBench only: ``APP_ENV=prod`` refuses to start with it.
    space_enabled: bool = False
    #: Origin of SPACE (``https://space.score.us.es``); the client adds ``/api/v1``.
    space_url: Optional[str] = None
    #: SPACE key with the MANAGEMENT scope.
    space_api_key: Optional[str] = None
    space_timeout_ms: int = 5000
    #: What a ``null`` limit in SPACE's token means. Off (the default): ``null`` is
    #: an authoritative "unlimited", which is how the token has been read so far.
    #: On: ``null`` is a limit SPACE did not declare, so it is *unknown* and is
    #: left out of the plan exactly like an absent one (the size limit then falls
    #: back to its technical safeguard or refuses, concurrency to its technical
    #: cap, and the numeric allowances fail closed at zero). For use if SPACE is
    #: confirmed to send ``null`` for "not declared" (``SPACE_NULL_LIMIT_IS_UNKNOWN``).
    #: It changes how the token is read, not the remote contract.
    space_null_limit_is_unknown: bool = False
    #: The pricing version new contracts are pinned to, and the version the
    #: public pricing endpoints show. SPACE/SPHERE own the version lifecycle.
    space_pricing_version: Optional[str] = None
    #: Plan a new sign-up starts on (for example ``BASIC``). Unset, the account
    #: is created without a plan and SPACE assigns the contract's plan.
    space_default_plan: Optional[str] = None
    #: The SPACE service this gateway reads and writes contracts for
    #: (``SPACE_SERVICE_NAME``). Production is ``openbinding``; a development
    #: deployment names its own service (for example ``openbinding-dev``) so
    #: it never touches production contracts. The one source of this name:
    #: ``space_client`` takes it from here.
    space_service_name: str = DEFAULT_SPACE_SERVICE_NAME
    #: The SPACE organization pricing tokens are issued for
    #: (``SPACE_ORGANIZATION_ID``): their ``aud`` and ``organizationId``.
    #: Required when SPACE is enabled (refused at startup in production), because
    #: every token is verified against SPACE's published keys (JWKS) before it is
    #: believed.
    space_organization_id: Optional[str] = None
    #: The ``iss`` of SPACE's pricing tokens (``SPACE_TOKEN_ISSUER``; SPACE's
    #: ``JWT_ISSUER``, ``space`` by default).
    space_token_issuer: str = "space"
    #: Tolerance, in seconds, for the ``exp`` of a pricing token
    #: (``SPACE_TOKEN_LEEWAY_S``).
    space_token_leeway_s: float = Field(default=30.0, ge=0)

    # -- Durable jobs and artifacts -------------------------------------
    redis_url: str = "redis://redis:6379/0"
    job_dispatch_mode: Literal["inline", "dramatiq"] = "inline"
    artifact_root: str = "/var/lib/openbinding/artifacts"
    #: Origin the gateway is reached by, used to build links
    #: (``PUBLIC_BASE_URL``): scheme://host[:port], one trailing / tolerated;
    #: checked at startup like the CORS origins.
    public_base_url: str = "http://localhost:8000"

    #: Origin of the frontend sign-in returns the browser to (``FRONTEND_URL``); same format as ``PUBLIC_BASE_URL``.
    frontend_url: str = "http://localhost:5173"
    expose_recovery_tokens: bool = False

    # -- Identity -------------------------------------------------------
    #: Who signs people in (``AUTH_PROVIDER``): ``scoretech``, SCORETech Identity through the gateway's
    #: OIDC client (docs/IDENTITY.md), or ``local``, OpenBinding's own accounts with passwords, kept for
    #: development, labs and rollback. ``local`` in production starts with a warning.
    auth_provider: Literal["local", "scoretech"] = "local"
    #: The Identity realm's issuer (``SCORETECH_IDENTITY_ISSUER``), exactly as its tokens name it:
    #: https (http only on a loopback host), no userinfo, query, fragment or trailing '/', ending in
    #: ``/realms/<realm>``. Required in ``scoretech`` mode.
    scoretech_identity_issuer: Optional[str] = None
    #: The confidential client of this deployment (``SCORETECH_IDENTITY_CLIENT_ID``, at most 255
    #: characters) and its secret (``SCORETECH_IDENTITY_CLIENT_SECRET``, or ``_FILE``). Required in
    #: ``scoretech`` mode; neither ever reaches a response.
    scoretech_identity_client_id: Optional[str] = Field(default=None, max_length=255)
    scoretech_identity_client_secret: Optional[SecretStr] = None
    #: Where Identity returns the browser (``SCORETECH_IDENTITY_CALLBACK_URL``); by default
    #: ``PUBLIC_BASE_URL`` + ``/api/v1/auth/identity/callback``. On ``FRONTEND_URL``'s origin, and its path
    #: ends in ``/v1/auth/identity/callback``; the browser starts sign-in at its sibling ``…/login``.
    scoretech_identity_callback_url: Optional[str] = None
    #: The Identity account page (``SCORETECH_IDENTITY_ACCOUNT_URL``); by default the issuer with
    #: ``/auth/realms/<realm>`` replaced by ``/account/``.
    scoretech_identity_account_url: Optional[str] = None
    #: Where the gateway itself reaches the realm when that differs from the issuer
    #: (``SCORETECH_IDENTITY_TRANSPORT_URL``, labs: ``http://keycloak:8080/identity/auth/realms/score``):
    #: only the issuer prefix of each endpoint is rewritten, and every token is still checked against the
    #: issuer. https, or http when the issuer is loopback http; ends in the same ``/realms/<realm>``.
    scoretech_identity_transport_url: Optional[str] = None
    #: The Identity permission an account needs to use OpenBinding
    #: (``SCORETECH_IDENTITY_REQUIRED_PERMISSION``), checked in the access token at every sign-in and
    #: renewal; empty switches the check off (Identity's own admission still applies).
    scoretech_identity_required_permission: str = "openbinding:access"
    #: Where the one-time records of sign-in (flow state, pending sign-ups) and the session lock live
    #: (``IDENTITY_STORE_BACKEND``): ``redis``, shared by every worker, or ``memory`` for one process
    #: (refused in production).
    identity_store_backend: Literal["memory", "redis"] = "redis"
    #: The longest a browser session lives, and how long it lives without a renewal
    #: (``SESSION_MAX_S``, ``SESSION_IDLE_S``): Identity's own SSO maximum and idle limits.
    session_max_s: int = Field(default=7 * 24 * 60 * 60, ge=60)
    session_idle_s: int = Field(default=12 * 60 * 60, ge=60)
    #: Institutional email domains that entitle an account to RESEARCH when SCORETech Identity verified its
    #: email (``RESEARCH_EMAIL_DOMAINS``, comma separated, lower-case hostnames): the part after the last ``@``
    #: must equal one of them, with no suffix matching.
    research_email_domains: str = "us.es,alum.us.es"
    #: The SCORETech Identity ``sub`` of the first administrator (``BOOTSTRAP_ADMIN_SUB``): promoted at sign-in
    #: while no active administrator exists. ``scoretech`` mode only; at most 255 characters.
    bootstrap_admin_sub: Optional[str] = Field(default=None, max_length=255)
    #: Days a personal API key (``obk_``) keeps working after its owner last signed in or renewed a session with
    #: SCORETech Identity (``API_KEY_ORPHAN_DAYS``, ``scoretech`` mode): a person's machine keys stop when the
    #: person stops proving they still hold an Identity account, and work again at their next sign-in.
    api_key_orphan_days: int = Field(default=30, ge=1, le=365)
    #: Extra browser origins the sign-in routes accept in ``Origin`` besides ``FRONTEND_URL``'s
    #: (``AUTH_TRUSTED_ORIGINS``, comma separated, exact ``scheme://host[:port]``): every entry has
    #: ``FRONTEND_URL``'s scheme, and only https in production. The ordinary lab's walks browse
    #: ``http://web:8080``.
    auth_trusted_origins: str = ""

    # -- SPHERE pricing source (read only) ------------------------------
    # Read by the PricingSource port (modules/plans). OpenBinding holds no SPHERE key of its own: an
    # organization connects its key (org_connections), a registry carries its operator key.
    #: Whether the default SPHERE (``SPHERE_URL``) is read; registries and Pricing2Yaml URLs are read either way.
    sphere_enabled: bool = False
    sphere_url: str = DEFAULT_SPHERE_URL
    sphere_timeout_s: float = Field(default=10.0, gt=0)
    #: The largest pricing answer read from SPHERE, a registry or a URL (``SPHERE_MAX_BYTES``).
    sphere_max_bytes: int = Field(default=5 * 1024 * 1024, gt=0)
    #: How long an anonymous SPHERE answer (manifest, discovery, family identity) is served from the
    #: process cache before it is revalidated with ``If-None-Match`` (``SPHERE_CACHE_TTL_S``).
    sphere_cache_ttl_s: float = Field(default=300.0, gt=0)
    #: The longest a SPHERE ``Retry-After`` or the port's own back-off keeps a bucket closed (``SPHERE_BACKOFF_MAX_S``).
    sphere_backoff_max_s: float = Field(default=60.0, gt=0)
    #: OpenBinding's own pricing family in SPHERE (``GET /v1/plans/pricing`` serves the version
    #: ``SPACE_PRICING_VERSION`` names from it).
    sphere_openbinding_pricing_id: str = Field(default="6ab0a323697330667ccce891", pattern=r"^[0-9a-f]{24}$")
    #: Redirects a user-supplied Pricing2Yaml URL may take, each revalidated (``OFFERING_URL_MAX_REDIRECTS``).
    offering_url_max_redirects: int = Field(default=3, ge=0, le=10)
    #: A URL read again within this many seconds of its last snapshot in a scope reuses it (``OFFERING_URL_MIN_INTERVAL_S``).
    offering_url_min_interval_s: float = Field(default=300.0, gt=0)
    #: The on-premise SPHERE registries a Composition2Yaml document may name
    #: (``SPHERE_REGISTRIES``), as JSON keyed by alias, for example
    #: ``{"lab": {"url": "https://sphere.lab.local", "api_key": "..."}}``. A
    #: ``registry:`` alias that is not here is an error in a ``from`` and a warning
    #: in an ``offering``. The URL must be https; secrets live here, never in a
    #: document. The pricing source reads each one with its operator key, and may
    #: reach private addresses (an on-premise registry), never redirected.
    sphere_registries: dict[str, SphereRegistry] = Field(default_factory=dict)

    # -- Composition2Yaml ------------------------------------------------
    #: Per-process slots for reading and writing documents, and for evaluating a
    #: composition with the toolchain; a request that finds them all taken is
    #: refused with 429 ``composition_busy`` instead of waiting.
    composition_language_slots: int = Field(default=4, ge=1)
    composition_evaluation_slots: int = Field(default=2, ge=1)

    # -- Diagnostics ------------------------------------------------------
    #: Failures of anonymous callers persisted as error events per client
    #: address and minute, whatever their status; the rest are served but not
    #: stored, and the next event stored says how many were dropped
    #: (``ANONYMOUS_ERROR_EVENTS_PER_MINUTE``; 0 switches the limit off).
    anonymous_error_events_per_minute: int = Field(default=30, ge=0)

    # -- Optional account notifications --------------------------------
    smtp_url: Optional[str] = None
    mail_from: Optional[str] = None

    # -- Logging --------------------------------------------------------
    log_level: str = "INFO"

    # -- Federated engines -----------------------------------------------
    #: Comma-separated Fernet keys protecting the credentials users register
    #: alongside their own solvers (``SECRETS_FERNET_KEYS``). The first key
    #: encrypts; every key decrypts, which is how a key is rotated: put the new
    #: one first, keep the old one until nothing is encrypted with it.
    secrets_fernet_keys: Optional[str] = None
    #: The single key of earlier deployments. Still read, after the keys above
    #: (it encrypts only when ``SECRETS_FERNET_KEYS`` is unset). Without either,
    #: federated engines that need authentication cannot be stored at all.
    federation_secret_key: Optional[str] = None
    #: Whether a federated engine must be reached over TLS. The instance and
    #: the credential both travel to it, so a deployment serving real users
    #: leaves this on; a developer testing against a local stub turns it off
    #: rather than running a certificate authority to do it.
    federation_require_https: bool = True

    # -- Startup checks --------------------------------------------------

    @field_validator("sphere_url", mode="before")
    @classmethod
    def sphere_url_is_https(cls, url: object) -> object:
        """An organization's key travels to ``SPHERE_URL``, so it is reached over https only (empty: the default)."""
        if url is None or (isinstance(url, str) and not url.strip()):
            return DEFAULT_SPHERE_URL
        if not isinstance(url, str) or not url.startswith("https://") or len(url) <= len("https://"):
            raise ValueError("SPHERE_URL must be an https URL")
        return url.rstrip("/")

    @field_validator("sphere_registries")
    @classmethod
    def registry_aliases_are_aliases(cls, registries: dict[str, SphereRegistry]) -> dict[str, SphereRegistry]:
        """Refuse an alias a document could not name."""
        for alias in registries:
            if not SPHERE_REGISTRY_ALIAS.fullmatch(alias):
                raise ValueError(
                    f"SPHERE_REGISTRIES has an invalid alias {alias!r}: lower-case letters, digits and inner "
                    "'-', at most 32 characters"
                )
        return registries

    @model_validator(mode="after")
    def closed_cors_in_production(self) -> "Settings":
        """Refuse to start a production gateway with an open or empty CORS list.

        Wildcards in development are tolerated (credentials are then switched
        off, see ``cors_credentials_allowed``); in production they are a
        misconfiguration, so the process fails with a message that names the
        variable instead of silently serving every origin.
        """
        if self.app_env != "prod":
            return self
        origins = self.cors_origin_list
        if not origins:
            raise ValueError(
                "CORS_ALLOW_ORIGINS is empty while APP_ENV=prod: list the exact "
                "frontend origins, comma separated (for example https://openbinding.example.org)."
            )
        if "*" in origins:
            raise ValueError(
                "CORS_ALLOW_ORIGINS contains '*' while APP_ENV=prod: a wildcard is not "
                "allowed in production; list the exact frontend origins instead."
            )
        return self

    @model_validator(mode="after")
    def well_formed_public_origins(self) -> "Settings":
        """Refuse a public origin a browser or a link builder would mishandle.

        The URLs tolerate one trailing slash (routes strip it); a CORS entry is
        exactly what the browser sends in ``Origin``, so it has none. A bare
        ``*`` is tolerated outside production (``closed_cors_in_production``
        refuses it there, with its own message).
        """
        for name, value in (("PUBLIC_BASE_URL", self.public_base_url), ("FRONTEND_URL", self.frontend_url)):
            _require_origin(name, value, trailing_slash=True)
        for entry in self.cors_origin_list:
            if entry == "*" and self.app_env != "prod":
                continue
            _require_origin("CORS_ALLOW_ORIGINS", entry, trailing_slash=False)
        return self

    @model_validator(mode="after")
    def strong_signing_secret(self) -> "Settings":
        """Refuse a weak or missing signing secret outside the test suite.

        HS256 is only as strong as its key. The suite (``APP_ENV=test``) signs
        with a throwaway; anywhere else a short value is a startup error, and
        production additionally refuses to start with no secret at all. In
        development an unset secret still means "authentication unavailable"
        (503), as it always did.
        """
        if self.app_env == "test":
            return self
        secret = self.gateway_jwt_secret
        if not secret:
            if self.app_env == "prod":
                raise ValueError(
                    "GATEWAY_JWT_SECRET is not set while APP_ENV=prod: set a random secret of at "
                    f"least {MIN_JWT_SECRET_LENGTH} characters (for example `openssl rand -hex 32`)."
                )
            return self
        if len(secret) < MIN_JWT_SECRET_LENGTH:
            raise ValueError(
                f"GATEWAY_JWT_SECRET is shorter than {MIN_JWT_SECRET_LENGTH} characters: use a random "
                "secret (for example `openssl rand -hex 32`)."
            )
        return self

    @model_validator(mode="after")
    def json_limit_within_request_limit(self) -> "Settings":
        if self.max_json_body_bytes > self.max_request_body_bytes:
            raise ValueError("MAX_JSON_BODY_BYTES cannot exceed MAX_REQUEST_BODY_BYTES.")
        return self

    @model_validator(mode="after")
    def valid_space_service_name(self) -> "Settings":
        """Refuse a service name SPACE could not hold, before any call uses it."""
        if not SPACE_SERVICE_NAME_PATTERN.fullmatch(self.space_service_name):
            raise ValueError(
                "SPACE_SERVICE_NAME must match [a-z0-9][a-z0-9_-]{1,62} "
                "(lower-case letters, digits, '_' and '-')."
            )
        return self

    @model_validator(mode="after")
    def space_required_in_production(self) -> "Settings":
        """Refuse to start a production gateway without SPACE.

        With ``SPACE_ENABLED=false`` the gateway grants every functional
        capability and meters nothing, which is only acceptable for local
        development and QacoBench.
        """
        if self.app_env == "prod" and not self.space_enabled:
            raise ValueError(
                "SPACE_ENABLED is false while APP_ENV=prod: production needs SPACE for plans "
                "and contracts. Set SPACE_ENABLED=true with SPACE_URL and SPACE_API_KEY; the "
                "stateless open gate is for development and QacoBench only."
            )
        return self

    @model_validator(mode="after")
    def space_organization_required_in_production(self) -> "Settings":
        """Refuse a production SPACE without the organization its pricing tokens are verified for.

        Elsewhere the startup check (``main.py``) warns instead, and every plan
        read answers 503 ``pricing_unavailable`` until it is set.
        """
        if self.app_env == "prod" and self.space_enabled and not (self.space_organization_id or "").strip():
            raise ValueError(
                "SPACE_ENABLED is true but SPACE_ORGANIZATION_ID is not set: pricing tokens are "
                "verified against SPACE's keys for that organization (their aud and organizationId)."
            )
        return self

    @model_validator(mode="after")
    def no_insecure_transport_in_production(self) -> "Settings":
        """Refuse plain-http switches in production.

        ``FEDERATION_REQUIRE_HTTPS=false`` lets federated engines be registered
        and called over http, which is for a trusted development or lab network
        only.
        """
        if self.app_env != "prod":
            return self
        if not self.federation_require_https:
            raise ValueError(
                "FEDERATION_REQUIRE_HTTPS is false while APP_ENV=prod: production must call federated "
                "engines over https. Unset it, or use APP_ENV=dev for a trusted private network."
            )
        return self

    @model_validator(mode="after")
    def identity_configuration(self) -> "Settings":
        """Fail closed on a SCORETech Identity configuration that could not work safely.

        Checked in every mode: the store backend and ``EXPOSE_RECOVERY_TOKENS`` in production, and the
        trusted origins. In ``scoretech`` mode: the issuer, the client, the callback, account and transport
        URLs, one origin for the frontend, the gateway and the callback (the session cookie is
        same-origin), a usable credential key (the refresh token is encrypted with it), and no seeded
        password administrator. Messages name the setting and never its value when it is a secret.
        """
        if self.app_env == "prod" and self.identity_store_backend == "memory":
            raise ValueError(
                "IDENTITY_STORE_BACKEND=memory while APP_ENV=prod: sign-in state and the session lock "
                "must be shared by every worker; use redis."
            )
        if self.app_env == "prod" and self.expose_recovery_tokens:
            raise ValueError(
                "EXPOSE_RECOVERY_TOKENS is true while APP_ENV=prod: it would let anybody reset any "
                "account's password by naming its email. It is for labs without mail only."
            )
        for domain in self.research_email_domain_list:
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", domain):
                raise ValueError(
                    f"RESEARCH_EMAIL_DOMAINS has {domain!r}: list lower-case hostnames, comma separated "
                    "(for example us.es,alum.us.es)."
                )
        frontend_scheme = urlsplit(self.frontend_url).scheme
        for entry in self.auth_trusted_origin_list:
            _require_origin("AUTH_TRUSTED_ORIGINS", entry, trailing_slash=False)
            scheme = urlsplit(entry).scheme
            if scheme != frontend_scheme:
                raise ValueError(
                    f"AUTH_TRUSTED_ORIGINS has {entry!r}, whose scheme is not FRONTEND_URL's "
                    f"({frontend_scheme}): cookie names and Secure follow FRONTEND_URL's scheme."
                )
            if self.app_env == "prod" and scheme != "https":
                raise ValueError(f"AUTH_TRUSTED_ORIGINS has {entry!r} while APP_ENV=prod: https only.")
        if self.auth_provider != "scoretech":
            return self
        issuer = _identity_url("SCORETECH_IDENTITY_ISSUER", self.scoretech_identity_issuer)
        realm = _realm_of(issuer)
        if realm is None:
            raise ValueError(
                "SCORETECH_IDENTITY_ISSUER must end in /realms/<realm> (the realm's issuer, for example "
                "https://sphere.score.us.es/identity/auth/realms/score)."
            )
        if not (self.scoretech_identity_client_id or "").strip():
            raise ValueError("SCORETECH_IDENTITY_CLIENT_ID is required when AUTH_PROVIDER=scoretech.")
        secret = self.scoretech_identity_client_secret
        if secret is None or not secret.get_secret_value().strip():
            raise ValueError(
                "SCORETECH_IDENTITY_CLIENT_SECRET (or SCORETECH_IDENTITY_CLIENT_SECRET_FILE) is required "
                "when AUTH_PROVIDER=scoretech."
            )
        frontend = _identity_url("FRONTEND_URL", self.frontend_url.rstrip("/"))
        public = self.public_base_url.rstrip("/")
        if _origin(public) != _origin(frontend):
            raise ValueError(
                "PUBLIC_BASE_URL and FRONTEND_URL must share one origin when AUTH_PROVIDER=scoretech: the "
                "session cookie is same-origin."
            )
        callback = _identity_url("SCORETECH_IDENTITY_CALLBACK_URL", self.identity_callback_url)
        if _origin(callback) != _origin(frontend) or not urlsplit(callback).path.endswith(IDENTITY_CALLBACK_PATH):
            raise ValueError(
                "SCORETECH_IDENTITY_CALLBACK_URL must be on FRONTEND_URL's origin and end in "
                f"{IDENTITY_CALLBACK_PATH}."
            )
        account = self.scoretech_identity_account_url
        if account:
            parts = urlsplit(account)
            if parts.username or parts.password or parts.query:
                raise ValueError("SCORETECH_IDENTITY_ACCOUNT_URL must have no userinfo or query.")
            _identity_url("SCORETECH_IDENTITY_ACCOUNT_URL", f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/"))
        transport = self.scoretech_identity_transport_url
        if transport:
            parts = urlsplit(transport.rstrip("/"))
            loopback_http_issuer = urlsplit(issuer).scheme == "http"
            if parts.scheme not in ("https", "http") or (parts.scheme == "http" and not loopback_http_issuer):
                raise ValueError(
                    "SCORETECH_IDENTITY_TRANSPORT_URL must be https, or http only when the issuer is a "
                    "loopback http URL (a lab)."
                )
            if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
                raise ValueError("SCORETECH_IDENTITY_TRANSPORT_URL must have a host and no userinfo, query or fragment.")
            if _realm_of(transport.rstrip("/")) != realm:
                raise ValueError(
                    f"SCORETECH_IDENTITY_TRANSPORT_URL must end in the issuer's /realms/{realm}."
                )
        if self.seed_default_admin:
            raise ValueError(
                "SEED_DEFAULT_ADMIN is set while AUTH_PROVIDER=scoretech: a password account could never "
                "sign in. The first administrator comes from BOOTSTRAP_ADMIN_SUB."
            )
        if not _fernet_available(self.secrets_fernet_keys, self.federation_secret_key):
            raise ValueError(
                "AUTH_PROVIDER=scoretech needs SECRETS_FERNET_KEYS (or the legacy FEDERATION_SECRET_KEY) "
                "holding valid Fernet keys: the Identity refresh token is stored encrypted with them."
            )
        return self

    # -- Derived values --------------------------------------------------

    @property
    def research_email_domain_list(self) -> List[str]:
        return [item.strip() for item in self.research_email_domains.split(",") if item.strip()]

    @property
    def auth_trusted_origin_list(self) -> List[str]:
        return [item.strip() for item in self.auth_trusted_origins.split(",") if item.strip()]

    @property
    def trusted_browser_origins(self) -> frozenset[str]:
        """The origins the sign-in routes accept in ``Origin``: ``FRONTEND_URL``'s plus ``AUTH_TRUSTED_ORIGINS``."""
        return frozenset({_origin(self.frontend_url.rstrip("/")), *self.auth_trusted_origin_list})

    @property
    def identity_secure_cookies(self) -> bool:
        """Whether the session cookies are ``__Host-`` and ``Secure``: ``FRONTEND_URL`` is https."""
        return urlsplit(self.frontend_url).scheme == "https"

    @property
    def identity_issuer(self) -> str:
        return (self.scoretech_identity_issuer or "").rstrip("/")

    @property
    def identity_callback_url(self) -> str:
        """``SCORETECH_IDENTITY_CALLBACK_URL``, or ``PUBLIC_BASE_URL`` + ``/api/v1/auth/identity/callback``."""
        configured = (self.scoretech_identity_callback_url or "").strip()
        return configured or f"{self.public_base_url.rstrip('/')}/api{IDENTITY_CALLBACK_PATH}"

    @property
    def identity_login_url(self) -> str:
        """Where the browser starts a sign-in: the callback's sibling ``…/login``."""
        callback = self.identity_callback_url
        return callback[: -len("/callback")] + "/login"

    @property
    def identity_account_url(self) -> str:
        """The Identity account page, with ``#public-profile``."""
        configured = (self.scoretech_identity_account_url or "").strip()
        base = configured or re.sub(r"/auth/realms/[^/]+$", "/account/", self.identity_issuer)
        return base.split("#", 1)[0] + "#public-profile"


    @property
    def sphere_registry_aliases(self) -> frozenset[str]:
        """The registry aliases a document may name; the pricing source (``modules/plans``) reads the rest."""
        return frozenset(self.sphere_registries)

    @property
    def cors_origin_list(self) -> List[str]:
        """The configured origins, as a list."""
        return [item.strip() for item in self.cors_allow_origins.split(",") if item.strip()]

    @property
    def cors_expose_headers(self) -> List[str]:
        """The response headers browsers may read cross-origin."""
        return list(CORS_EXPOSED_HEADERS)

    @property
    def cors_credentials_allowed(self) -> bool:
        """Whether credentialed requests are allowed, wildcard rule included.

        A wildcard origin and credentials are mutually exclusive per the CORS
        spec, and browsers reject the combination outright. Deciding it here
        means the configuration cannot express something a browser will refuse
        to honour, and the one place that mattered - a development default of
        ``*`` silently disabling authenticated requests - is now visible.
        """
        if "*" in self.cors_origin_list:
            return False
        return self.cors_allow_credentials

    @property
    def engine_urls(self) -> dict:
        """Resolve built-in mode endpoints from the v1 manifest directory."""
        urls = {
            "minizinc-csp": self.engine_minizinc_url,
            "random-search": self.engine_random_search_url,
            "many-heuristic": self.engine_many_heuristic_url,
            "evolutionary-heuristics": self.engine_evolutionary_heuristics_url,
        }
        manifest_root = os.path.join(self.schemas_dir, "bim", "v1", "manifests")
        if not os.path.isdir(manifest_root):
            return urls
        for filename in os.listdir(manifest_root):
            if not filename.endswith(".json"):
                continue
            engine_id = filename[:-5]
            configured = os.environ.get("ENGINE_" + engine_id.replace("-", "_").upper() + "_URL")
            if configured:
                urls[engine_id] = configured
        return urls


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """The settings, read once per process.

    Cached because configuration does not change while the gateway runs, and
    because several of these values are read on every request. A test that
    needs to vary the environment should call ``get_settings.cache_clear()``
    after changing it.
    """
    return Settings()
