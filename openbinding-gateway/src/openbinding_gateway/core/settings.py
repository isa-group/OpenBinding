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
wildcard list stops the process at startup. Two rules that used to live at their
call sites now live here, where they can be stated once: the
wildcard-versus-credentials rule for CORS, and the fact that a schema path from
the environment is only a preference, not a promise that the file exists.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import List, Literal, Optional

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


class Settings(BaseSettings):
    """The gateway's configuration, read from the environment once."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        # The process environment carries far more than this class describes,
        # and a stray variable is not a configuration error.
        extra="ignore",
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
    #: Absolute infrastructure guardrails, independent of any plan. Pricing
    #: publication is rejected when it promises more than these values.
    technical_max_payload_bytes: int = 512 * 1024 * 1024
    pricing_document_max_bytes: int = 2 * 1024 * 1024
    #: Queued plus running jobs one account may have at once; a creation past it
    #: is refused with 429 ``concurrency_limit_exceeded``. A technical limit
    #: that protects the engines, independent of the plan
    #: (``MAX_CONCURRENT_JOBS_PER_USER``).
    max_concurrent_jobs_per_user: int = Field(default=8, ge=1)

    # -- v1 schemas ------------------------------------------------------
    #: Directory holding the BIM v1 schemas and manifests.
    schemas_dir: str = "/app/schemas"

    # -- CORS ------------------------------------------------------------
    #: Comma-separated browser origins allowed to call the API: a closed list.
    #: The default is only the local development origins of the frontend (Vite
    #: dev server and the Playwright server), because the sessions' tokens live
    #: in the browser's ``localStorage`` and a wildcard would let any site read
    #: the API as the signed-in user. In ``APP_ENV=prod`` an empty list or a
    #: ``*`` entry is refused at startup (see ``closed_cors_in_production``).
    cors_allow_origins: str = DEV_CORS_ORIGINS
    cors_allow_credentials: bool = True

    # -- Database --------------------------------------------------------
    #: Async SQLAlchemy URL. The gateway runs without a database until the
    #: user module needs one, which is why this is optional.
    database_url: Optional[str] = None

    # -- Authentication --------------------------------------------------
    #: Signing key for the gateway's own session tokens. Must be set before
    #: authentication is switched on; there is deliberately no default, so a
    #: deployment cannot accidentally ship a well-known secret.
    gateway_jwt_secret: Optional[str] = None
    access_token_ttl_s: int = 15 * 60
    refresh_token_ttl_s: int = 30 * 24 * 60 * 60

    # -- The first administrator -----------------------------------------
    #: Registration is open and produces ordinary users, so a fresh deployment
    #: has no administrator and no way to acquire one - promoting an account is
    #: itself an administrator's privilege. These seed or promote the first.
    #: Ignored once any administrator exists.
    bootstrap_admin_username: Optional[str] = None
    bootstrap_admin_email: Optional[str] = None
    bootstrap_admin_password: Optional[str] = None
    #: Plan the bootstrap administrator is contracted on. The backend names no
    #: commercial plan: unset, it is the highest-capacity plan of the published
    #: iPricing (``space/pricing/openbinding.yml``).
    bootstrap_admin_plan: Optional[str] = None

    # -- SPACE (pricing-driven access control) ---------------------------
    space_enabled: bool = False
    space_url: Optional[str] = None
    space_api_key: Optional[str] = None
    space_timeout_ms: int = 5000
    # Only a compatibility override for tooling. Runtime contracts always use
    # the explicit LIVE release recorded in PostgreSQL.
    space_pricing_version: Optional[str] = None
    #: What to do when SPACE cannot be reached. ``closed`` refuses to solve
    #: rather than hand out unaccounted compute; ``open`` lets the request
    #: through, which is what local development wants.
    space_fail_mode: Literal["open", "closed"] = "closed"
    space_destructive_api_key: Optional[str] = None

    # -- Durable jobs and artifacts -------------------------------------
    redis_url: str = "redis://redis:6379/0"
    job_dispatch_mode: Literal["inline", "dramatiq"] = "inline"
    artifact_root: str = "/var/lib/openbinding/artifacts"
    public_base_url: str = "http://localhost:8000"

    # -- Universidad de Sevilla CAS ------------------------------------
    cas_enabled: bool = False
    cas_environment: Literal["production", "preproduction"] = "production"
    cas_base_url: Optional[str] = None
    frontend_url: str = "http://localhost:5173"
    cas_state_ttl_s: int = 10 * 60
    cas_exchange_ttl_s: int = 30
    cas_store_backend: Literal["memory", "redis"] = "redis"
    expose_recovery_tokens: bool = False

    # -- SPHERE pricing source ------------------------------------------
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
    #: Fernet key protecting the credentials users register alongside their
    #: own solvers. Without it, federated engines that need authentication
    #: cannot be stored at all.
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
