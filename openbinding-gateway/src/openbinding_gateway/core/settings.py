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

from pydantic import Field, model_validator
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
#: (archive downloads) and ``Idempotency-Key`` (job submission).
CORS_EXPOSED_HEADERS = (
    "Retry-After",
    "ETag",
    "Location",
    "Content-Disposition",
    "Digest",
    "Idempotency-Key",
)


#: Shortest accepted ``GATEWAY_JWT_SECRET`` outside ``APP_ENV=test``.
MIN_JWT_SECRET_LENGTH = 32

#: Default ``iss`` and ``aud`` of the gateway's session tokens.
DEFAULT_JWT_ISSUER = "openbinding-gateway"

#: The production SPACE service, and the default of ``SPACE_SERVICE_NAME``.
DEFAULT_SPACE_SERVICE_NAME = "openbinding"

#: Shape of a SPACE service name (``SPACE_SERVICE_NAME``).
SPACE_SERVICE_NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{1,62}")


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


# [impl->req~gateway-api-public-origin-format~1]
# [impl->req~gateway-api-cors-origin-format~1]
# [impl->req~gateway-api-origin-error-masking~1]
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
    #: Technical ceiling, in log10 units, on the binding space (the estimated number
    #: of candidate combinations) of one job or study cell; ``None`` sets none
    #: (``MAX_BINDING_SPACE_LOG10``). It applies on top of the plan's
    #: ``maxInstanceComplexityLog10`` and stands in for it when the plan declares no
    #: usable value; with neither, the instance is refused. See
    #: ``domain/binding_space.py``.
    max_binding_space_log10: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    #: Technical ceiling on the cells (jobs) one study run expands to; ``None``
    #: sets none (``MAX_CELLS_PER_STUDY_RUN``). A run over it is refused whole
    #: with 422 ``study_run_too_large`` before anything is written. A safeguard
    #: of the deployment, not a plan entitlement: no plan raises it.
    max_cells_per_study_run: Optional[int] = Field(default=None, ge=1)
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

    # -- BIM toolchain ---------------------------------------------------
    #: Where the BIM language runs: ``inproc`` calls the installed ``bim-core``
    #: in this process (development, tests, workers that carry it); ``http``
    #: calls a ``bim-service`` (``BIM_SERVICE_URL``). Everything else in the
    #: gateway talks to ``integrations.bim.get_bim()`` and does not care.
    bim_mode: Literal["inproc", "http"] = "inproc"
    #: Root of the service (``https://bim.internal``); required when ``BIM_MODE=http``.
    bim_service_url: Optional[str] = None
    #: File whose first line is the bearer token of the service. Never the token itself.
    bim_service_token_file: Optional[str] = None
    #: Seconds the gateway waits for one answer of the service.
    bim_service_timeout_s: float = Field(default=30.0, gt=0)
    #: Opaque tenant label sent as ``X-BIM-Tenant`` (logs and fair sharing of the
    #: service; it never changes a result).
    bim_tenant: Optional[str] = None
    #: Allow the bearer token to travel over plain ``http`` to a host that is not the loopback
    #: (``BIM_SERVICE_ALLOW_INSECURE_HTTP``). Off by default: only for a trusted private network.
    bim_service_allow_insecure_http: bool = False

    # -- CORS ------------------------------------------------------------
    #: Comma-separated browser origins allowed to call the API: a closed list.
    #: The default is only the local development origins of the frontend (Vite
    #: dev server and the Playwright server), because the sessions' tokens live
    #: in the browser's ``localStorage`` and a wildcard would let any site read
    #: the API as the signed-in user. In ``APP_ENV=prod`` an empty list or a
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
    access_token_ttl_s: int = 15 * 60
    refresh_token_ttl_s: int = 30 * 24 * 60 * 60
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
    #: outage costs one timeout per period rather than one per login.
    auth_rate_limit_redis_retry_s: float = Field(default=15.0, gt=0)

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

    # -- Durable jobs and artifacts -------------------------------------
    redis_url: str = "redis://redis:6379/0"
    job_dispatch_mode: Literal["inline", "dramatiq"] = "inline"
    artifact_root: str = "/var/lib/openbinding/artifacts"
    #: Origin the gateway is reached by, used to build links
    #: (``PUBLIC_BASE_URL``): scheme://host[:port], one trailing / tolerated;
    #: checked at startup like the CORS origins.
    public_base_url: str = "http://localhost:8000"

    # -- Universidad de Sevilla CAS ------------------------------------
    cas_enabled: bool = False
    cas_environment: Literal["production", "preproduction"] = "production"
    cas_base_url: Optional[str] = None
    #: Origin of the frontend the CAS flow returns to (``FRONTEND_URL``); same
    #: format as ``PUBLIC_BASE_URL``.
    frontend_url: str = "http://localhost:5173"
    cas_state_ttl_s: int = 10 * 60
    cas_exchange_ttl_s: int = 30
    cas_store_backend: Literal["memory", "redis"] = "redis"
    expose_recovery_tokens: bool = False

    # -- SPHERE pricing source (read only) ------------------------------
    sphere_enabled: bool = False
    sphere_url: str = "https://sphere.score.us.es"
    sphere_api_key: Optional[str] = None
    sphere_organization_name: Literal["OpenBinding"] = "OpenBinding"
    sphere_organization_id: Optional[str] = None
    sphere_pricing_slug: Literal["openbinding"] = "openbinding"
    sphere_timeout_s: float = 10.0

    # -- Collaboration ----------------------------------------------------
    #: Days a billing-sponsor proposal waits for the proposed person's answer
    #: before it expires (``SPONSOR_PROPOSAL_TTL_DAYS``).
    sponsor_proposal_ttl_days: int = Field(default=14, ge=1, le=365)
    #: Reads of public projects by people who are not members are limited per
    #: caller (the account, or the client address when anonymous) and per
    #: minute; they are never charged to the project's sponsor
    #: (``PUBLIC_READ_RATE_PER_MINUTE``; 0 switches the limit off).
    public_read_rate_per_minute: int = Field(default=240, ge=0)

    # -- Diagnostics ------------------------------------------------------
    #: Anonymous 401/404 responses persisted as error events per client
    #: address and minute; the rest are served but not stored
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
    def bim_service_url_for_http(self) -> "Settings":
        if self.bim_mode == "http" and not self.bim_service_url:
            raise ValueError("BIM_SERVICE_URL is not set while BIM_MODE=http: name the root of the bim-service.")
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
    def no_insecure_transport_in_production(self) -> "Settings":
        """Refuse plain-http switches in production.

        ``BIM_SERVICE_ALLOW_INSECURE_HTTP`` sends the bim-service bearer token in
        clear text and ``FEDERATION_REQUIRE_HTTPS=false`` lets federated engines
        be registered and called over http. Both are for a trusted development or
        lab network only.
        """
        if self.app_env != "prod":
            return self
        if self.bim_service_allow_insecure_http:
            raise ValueError(
                "BIM_SERVICE_ALLOW_INSECURE_HTTP is true while APP_ENV=prod: production must reach "
                "the bim-service over https. Unset it, or use APP_ENV=dev for a trusted private network."
            )
        if not self.federation_require_https:
            raise ValueError(
                "FEDERATION_REQUIRE_HTTPS is false while APP_ENV=prod: production must call federated "
                "engines over https. Unset it, or use APP_ENV=dev for a trusted private network."
            )
        return self

    # -- Derived values --------------------------------------------------

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

    @property
    def effective_cas_base_url(self) -> str:
        if self.cas_base_url:
            return self.cas_base_url.rstrip("/")
        return (
            "https://sso.us.es/CAS"
            if self.cas_environment == "production"
            else "https://ssopre.us.es/CAS"
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """The settings, read once per process.

    Cached because configuration does not change while the gateway runs, and
    because several of these values are read on every request. A test that
    needs to vary the environment should call ``get_settings.cache_clear()``
    after changing it.
    """
    return Settings()
