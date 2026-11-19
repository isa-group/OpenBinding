"""The sign-in routes: ``GET /v1/auth/config`` and the SCORETech Identity backend-for-frontend.

Every ``/v1/auth`` route is mounted in both modes and declares the mode it serves with
``requires_provider`` (``tests/identity/test_auth_route_modes.py`` enumerates them), so there is one OpenAPI
document whatever ``AUTH_PROVIDER`` says. Adapted from SPHERE's ``ScoretechIdentityController``
(SCORELabUS/SPHERE@73779a8a, MIT), whose mode policy matched paths by regex.
"""

from __future__ import annotations

from functools import lru_cache

from fastapi import APIRouter, Depends

from ....core.settings import Settings, get_settings
from ....models.accounts import AuthConfigView
from ..application.config import Provider, auth_config_view, refuse_outside

router = APIRouter(prefix="/v1/auth", tags=["Authentication"])


@lru_cache(maxsize=None)
def requires_provider(mode: Provider, *, browser: bool = False):
    """A dependency that refuses (409) a request for a route of another mode than the gateway's.

    ``browser`` routes are navigated to, not fetched: they answer a redirect themselves instead of a 409.
    The returned function carries ``auth_provider`` so the route table can be checked.
    """

    def dependency(settings: Settings = Depends(get_settings)) -> None:
        if not browser:
            refuse_outside(mode, settings)

    dependency.auth_provider = mode  # type: ignore[attr-defined]
    dependency.__name__ = f"requires_provider_{mode}{'_browser' if browser else ''}"
    return dependency


@router.get(
    "/config",
    response_model=AuthConfigView,
    operation_id="getAuthConfig",
    summary="How this gateway signs people in",
    dependencies=[Depends(requires_provider("any"))],
)
async def get_auth_config(settings: Settings = Depends(get_settings)) -> AuthConfigView:
    """The provider and, in `scoretech` mode, where the browser signs in, registers and manages its account.

    Public; it names no secret, client id or internal address.
    """
    return auth_config_view(settings)
