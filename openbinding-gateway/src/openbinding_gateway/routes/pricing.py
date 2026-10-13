"""The published pricing, read only.

SPHERE owns the Pricing2Yaml versions and SPACE the plans and contracts; both are
administered in their own consoles. These endpoints only show the version named
by ``SPACE_PRICING_VERSION`` to the public Pricing page and the renderer, read
from SPHERE and checked against the digest pinned for that immutable version.
No YAML is stored here and nothing in SPHERE or SPACE is changed.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response

from ..core.public_errors import PUBLISHED_PRICING_UNAVAILABLE, pricing_unavailable_error
from ..core.settings import Settings, get_settings
from ..models.pricing import PricingCurrentView
from ..pricing_catalog import PricingCatalogError, PublishedPricing, published_pricing

UNAVAILABLE = {
    "description": (
        "The published pricing cannot be read: SPHERE is not enabled, `SPACE_PRICING_VERSION` "
        "is not set, or SPHERE does not serve that public version (`pricing_unavailable`)."
    )
}

public_router = APIRouter(
    prefix="/v1/pricing", tags=["Pricing"], responses={503: UNAVAILABLE}
)


async def _published(settings: Settings) -> PublishedPricing:
    """The published pricing; whatever stops it, an anonymous caller reads one fixed sentence.

    The reason (SPHERE not enabled, the version not set, what SPHERE answered)
    goes to the log with the ``correlationId`` of the 503.
    """
    if not settings.sphere_enabled:
        raise pricing_unavailable_error(
            PricingCatalogError("SPHERE is not enabled."),
            where="published pricing",
            problem=PUBLISHED_PRICING_UNAVAILABLE,
        )
    try:
        return await published_pricing(settings)
    except PricingCatalogError as exc:
        raise pricing_unavailable_error(
            exc, where="published pricing", problem=PUBLISHED_PRICING_UNAVAILABLE
        ) from exc


@public_router.get("/current", response_model=PricingCurrentView, operation_id="getCurrentPricing")
async def current_pricing(settings: Settings = Depends(get_settings)) -> PricingCurrentView:
    value = await _published(settings)
    return PricingCurrentView(version=value.version, digest=value.digest, url=value.url)


@public_router.get(
    "",
    deprecated=True,
    operation_id="getPricingDocument",
    response_class=Response,
    responses={200: {"content": {"application/yaml": {"schema": {"type": "string"}}}}},
)
async def proxy_current_pricing(settings: Settings = Depends(get_settings)) -> Response:
    value = await _published(settings)
    return Response(
        value.content,
        media_type="application/yaml",
        headers={"ETag": f'"{value.digest}"', "Cache-Control": "public, max-age=300"},
    )


@public_router.get("/catalog", operation_id="getPricingCatalog")
async def pricing_catalog(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Return the published, digest-verified Pricing2Yaml document unchanged, as JSON."""
    return (await _published(settings)).public_view()
