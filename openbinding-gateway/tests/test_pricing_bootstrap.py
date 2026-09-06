"""Fresh installations bootstrap account roles from SPHERE, never a local table."""

from openbinding_gateway import pricing_catalog as catalog_module
from openbinding_gateway import space_client
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.pricing_catalog import live_catalog
from openbinding_gateway.space_client import FakePricingGate
from openbinding_gateway.sphere_client import SpherePricingVersion
from _pricing import PRICING_YAML, pricing_catalog


async def test_fresh_database_resolves_bootstrap_catalog_from_public_sphere_release(
    db_session, monkeypatch
) -> None:
    canonical = pricing_catalog()

    class FakeSphere:
        def __init__(self, _settings):
            pass

        async def exact_version(self, version: str) -> SpherePricingVersion:
            assert version == canonical.version
            return SpherePricingVersion(
                version=version,
                private=False,
                yaml_url="https://sphere.example/static/pricings/openbinding/release.yaml",
                organization_id="openbinding-org",
            )

        async def content(self, version: str) -> bytes:
            assert version == canonical.version
            return PRICING_YAML.read_bytes()

        async def aclose(self) -> None:
            return None

    previous = space_client.get_gate()
    space_client.set_gate(FakePricingGate())
    monkeypatch.setattr(catalog_module, "SphereClient", FakeSphere)
    try:
        resolved = await live_catalog(
            db_session,
            Settings(
                _env_file=None,
                sphere_enabled=True,
                sphere_api_key="server-side-key",
                space_pricing_version=canonical.version,
            ),
        )
    finally:
        space_client.set_gate(previous)

    assert resolved.digest == canonical.digest
    assert resolved.default_plan == canonical.default_plan
