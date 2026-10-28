"""M9.6: the Deprecation/Sunset mechanism of m24-sunset is gone.

No response carries ``Deprecation`` or ``Sunset``, browsers are offered exactly
six exposed headers, the module is gone, and the OpenAPI document declares
neither header and marks no operation deprecated outside ``/v1/pricing``.
"""

from __future__ import annotations

import importlib

import pytest

from openbinding_gateway import main
from openbinding_gateway.core.settings import CORS_EXPOSED_HEADERS
from openbinding_gateway.main import app

EXPOSED = {"Retry-After", "ETag", "Location", "Content-Disposition", "Digest", "Idempotency-Key"}
PRICING_PATHS = {"/v1/pricing", "/v1/pricing/catalog", "/v1/pricing/current"}
RETIREMENT_HEADERS = {"deprecation", "sunset"}
METHODS = {"get", "put", "post", "delete", "patch", "options", "head", "trace"}


@pytest.mark.parametrize(
    "path",
    [
        "/v1/analysis/sources",
        "/v1/organizations/isa-demo/projects/p1/resources",
        "/health",
        "/v1/explore/publications",
    ],
)
async def test_no_response_carries_a_retirement_header(api_client, path):
    # [utest->req~gateway-api-no-retirement-headers~1]
    response = await api_client.get(path)

    assert not RETIREMENT_HEADERS & {name.lower() for name in response.headers}, (path, dict(response.headers))


async def test_a_cross_origin_call_is_offered_exactly_six_headers(api_client):
    # [utest->req~gateway-api-cors-exposed-headers~1]
    origin = main.settings.cors_origin_list[0]

    response = await api_client.get("/health", headers={"Origin": origin})

    exposed = {name.strip() for name in response.headers["access-control-expose-headers"].split(",")}
    assert {name.lower() for name in exposed} == {name.lower() for name in EXPOSED}
    assert set(CORS_EXPOSED_HEADERS) == EXPOSED and len(CORS_EXPOSED_HEADERS) == 6


def test_the_deprecation_module_is_gone():
    # [utest->req~gateway-api-no-retirement-headers~1]
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("openbinding_gateway.core.deprecation")


def test_the_document_declares_no_retirement_header_and_no_retired_deprecation():
    # [utest->req~gateway-api-no-retirement-headers~1]
    document = app.openapi()

    declared = {name.lower() for name in document.get("components", {}).get("headers", {})}
    assert not RETIREMENT_HEADERS & declared
    deprecated = []
    for path, item in document["paths"].items():
        for method, operation in item.items():
            if method not in METHODS:
                continue
            if operation.get("deprecated"):
                deprecated.append((method, path))
            if path in PRICING_PATHS:
                continue
            for status, response in operation.get("responses", {}).items():
                headers = {name.lower() for name in response.get("headers", {})}
                assert not RETIREMENT_HEADERS & headers, (method, path, status)
    assert {path for _, path in deprecated} <= PRICING_PATHS, deprecated
