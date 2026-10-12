"""The Pricing2Yaml editing surface (templates, validation, drafts) is gone.

Pricings are written and published in the SPHERE console and deployed in the
SPACE console; the gateway only reads the published one. This file used to test
the editor snippets served to the administrator control room.
"""

from openbinding_gateway.main import app
from openbinding_gateway.routes import pricing


def test_the_pricing_routes_module_has_no_editing_surface() -> None:
    assert not hasattr(pricing, "admin_router")
    assert not hasattr(pricing, "pricing_templates")
    assert not hasattr(pricing, "validate_pricing")


def test_no_pricing_administration_route_is_served() -> None:
    paths = app.openapi()["paths"]
    assert not [path for path in paths if path.startswith("/v1/admin/pricing")]
    assert "/v1/admin/maintenance/reconcile-contracts" not in paths
