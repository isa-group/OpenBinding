"""The Pricing2Yaml editing surface (templates, validation, drafts) is gone.

Pricings are written and published in the SPHERE console and deployed in the
SPACE console; the gateway only reads the published one, through the pricing
source (``modules/plans``). This file used to test the editor snippets served
to the administrator control room; F3 deleted the last legacy pricing routes too.
"""

import importlib.util

from openbinding_gateway.main import app


def test_the_legacy_pricing_routes_module_is_gone() -> None:
    assert importlib.util.find_spec("openbinding_gateway.routes.pricing") is None


def test_no_pricing_administration_route_is_served() -> None:
    paths = app.openapi()["paths"]
    assert not [path for path in paths if path.startswith("/v1/admin/pricing")]
    assert "/v1/admin/maintenance/reconcile-contracts" not in paths
