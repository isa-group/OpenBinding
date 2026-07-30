"""Every knob the gateway reads from the environment, in one place.

Configuration used to be a scattering of ``os.getenv`` calls: the CORS rule in
``main``, the engine URLs in the registry, the solve timeout inside the router's
request loop, the schema paths in two modules that disagreed about the default.
Nothing was wrong with any one of them, but there was no way to answer "what can
be configured?" short of grepping, and a user module adding a database URL, a
signing secret and a SPACE endpoint is exactly the point where that stops being
tenable.

The values keep their historical names and defaults, so an existing deployment
needs no changes. Two rules that used to live at their call sites now live here,
where they can be stated once: the wildcard-versus-credentials rule for CORS,
and the fact that a schema path from the environment is only a preference, not a
promise that the file exists.
"""

from __future__ import annotations

from functools import lru_cache
from typing import List, Literal, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


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

    # -- Engines ---------------------------------------------------------
    # The defaults are the compose service names, so these only need setting
    # when the gateway runs outside the stack.
    engine_minizinc_url: str = "http://engine-minizinc:3000"
    engine_random_search_url: str = "http://engine-random-search:8080"
    engine_many_heuristic_url: str = "http://engine-many-heuristic:8080"
    engine_evolutionary_heuristics_url: str = "http://engine-evolutionary-heuristics:8080"

    #: How long the gateway waits for an engine before giving up. Note that
    #: nginx has its own read timeout in front of this one; the two are meant
    #: to be kept in step, with nginx's the larger of the two.
    engine_solve_timeout_s: float = 1800.0

    # -- Schemas ---------------------------------------------------------
    #: Preferred location of the general schema's root document. Unset means
    #: "work it out from the repository layout"; see ``models.api``.
    general_schema_path: Optional[str] = None
    #: Directory holding ``general/`` and ``manifests/``.
    schemas_dir: str = "/app/schemas"

    # -- CORS ------------------------------------------------------------
    #: Comma-separated browser origins allowed to call the API.
    cors_allow_origins: str = "*"
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
    #: Whether solving requires an account. Analysis stays public either way.
    auth_required_for_solve: bool = True

    # -- The first administrator -----------------------------------------
    #: Registration is open and produces ordinary users, so a fresh deployment
    #: has no administrator and no way to acquire one - promoting an account is
    #: itself an administrator's privilege. These seed or promote the first.
    #: Ignored once any administrator exists.
    bootstrap_admin_username: Optional[str] = None
    bootstrap_admin_email: Optional[str] = None
    bootstrap_admin_password: Optional[str] = None

    # -- SPACE (pricing-driven access control) ---------------------------
    space_enabled: bool = False
    space_url: Optional[str] = None
    space_api_key: Optional[str] = None
    space_timeout_ms: int = 5000
    #: What to do when SPACE cannot be reached. ``closed`` refuses to solve
    #: rather than hand out unaccounted compute; ``open`` lets the request
    #: through, which is what local development wants.
    space_fail_mode: Literal["open", "closed"] = "closed"

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

    # -- Derived values --------------------------------------------------

    @property
    def cors_origin_list(self) -> List[str]:
        """The configured origins, as a list."""
        return [item.strip() for item in self.cors_allow_origins.split(",") if item.strip()]

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
        """Engine id to base URL, for the registry's built-in engines."""
        return {
            "minizinc-csp": self.engine_minizinc_url,
            "random-search": self.engine_random_search_url,
            "many-heuristic": self.engine_many_heuristic_url,
            "evolutionary-heuristics": self.engine_evolutionary_heuristics_url,
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """The settings, read once per process.

    Cached because configuration does not change while the gateway runs, and
    because several of these values are read on every request. A test that
    needs to vary the environment should call ``get_settings.cache_clear()``
    after changing it.
    """
    return Settings()
