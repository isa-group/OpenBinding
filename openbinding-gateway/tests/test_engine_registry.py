"""One lookup for engines that arrive two different ways.

The registry is consulted from synchronous code - the validation pipeline, the
schema routes, the router - and registered engines live in an async database.
They meet through a cache, and these tests are about what that cache has to
guarantee: that a built-in engine behaves exactly as it did, that a registered
one is indistinguishable to every caller downstream, and that an engine
somebody may not see is *absent* rather than refused.

That last one is the same rule as a foreign job answering 404. Telling a
stranger that ``alice~tabu`` exists but is not theirs tells them about Alice.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import pytest

from openbinding_gateway.db.models import EngineStatus, EngineVisibility
from openbinding_gateway.federation.transport import BuiltinTransport, FederatedTransport
from openbinding_gateway.models.manifest import EngineManifest
from openbinding_gateway.registry.engine import EngineRegistry
from openbinding_gateway.registry.federated import FederatedEntry
from openbinding_gateway.validation.engine_plugins.federated import FederatedEnginePlugin

BUILT_INS = {"minizinc-csp", "random-search", "many-heuristic", "evolutionary-heuristics"}

THEIR_OPENAPI = {
    "openapi": "3.1.0",
    "servers": [{"url": "https://acme.example"}],
    "paths": {"/optimize": {"post": {"operationId": "postOptimize"}}},
}


@dataclass
class FakeUser:
    id: uuid.UUID
    is_admin: bool = False


def a_manifest(engine_id: str) -> EngineManifest:
    return EngineManifest.model_validate(
        {
            "manifest_version": "1",
            "engine_id": engine_id.split("~")[-1],
            "display_name": "ACME Tabu",
            "type": "HEURISTIC",
            "capabilities": {
                "composition_nodes_supported": ["TASK"],
                "objective_types_supported": ["MONO"],
            },
            "instance_schema": {"type": "object"},
            "transport": {
                "openapi": {"document": THEIR_OPENAPI},
                "operations": {"solve": {"operationId": "postOptimize"}},
                "response_mapping": {"binding": "/assignment"},
            },
        }
    )


def an_entry(
    engine_id: str = "alice~tabu",
    *,
    owner_id: uuid.UUID | None = None,
    visibility: EngineVisibility = EngineVisibility.PRIVATE,
    status: EngineStatus = EngineStatus.ACTIVE,
) -> FederatedEntry:
    manifest = a_manifest(engine_id)
    owner_id = owner_id or uuid.uuid4()
    return FederatedEntry(
        engine_id=engine_id,
        owner_id=owner_id,
        owner_username=engine_id.split("~")[0],
        visibility=visibility,
        status=status,
        plugin=FederatedEnginePlugin(manifest, owner=engine_id.split("~")[0]),
        transport=FederatedTransport(manifest, THEIR_OPENAPI, require_https=True),
    )


@pytest.fixture(autouse=True)
def empty_cache():
    """Every test starts with no registered engines, and leaves none behind."""
    EngineRegistry.refresh_federated([])
    yield
    EngineRegistry.refresh_federated([])


# -- The built-ins are untouched -------------------------------------------


def test_the_built_in_engines_are_still_there():
    assert BUILT_INS <= set(EngineRegistry.visible_engine_ids())


def test_a_built_in_engine_gets_the_built_in_transport():
    transport = EngineRegistry.get_transport("random-search")

    assert isinstance(transport, BuiltinTransport)
    assert transport.is_federated is False


def test_an_unknown_engine_is_still_a_plain_error():
    with pytest.raises(ValueError) as error:
        EngineRegistry.get_plugin("no-such-engine")

    assert "no-such-engine" in str(error.value)


# -- A registered engine looks like any other ------------------------------


def test_a_registered_engine_is_found_by_the_same_lookup():
    EngineRegistry.refresh_federated([an_entry()])

    plugin = EngineRegistry.get_plugin("alice~tabu")

    assert plugin.engine_id == "tabu"
    assert plugin.get_capabilities()["type"] == "HEURISTIC"


def test_a_registered_engine_gets_its_own_transport():
    EngineRegistry.refresh_federated([an_entry()])

    transport = EngineRegistry.get_transport("alice~tabu")

    assert transport.is_federated is True
    assert transport.base_url() == "https://acme.example"


def test_the_url_of_a_registered_engine_is_where_it_lives():
    EngineRegistry.refresh_federated([an_entry()])

    assert EngineRegistry.get_url("alice~tabu") == "https://acme.example"


def test_a_registered_engine_is_reported_as_federated():
    EngineRegistry.refresh_federated([an_entry()])

    assert EngineRegistry.is_federated("alice~tabu") is True
    assert EngineRegistry.is_federated("random-search") is False


def test_a_refresh_replaces_rather_than_accumulates():
    EngineRegistry.refresh_federated([an_entry("alice~tabu")])
    EngineRegistry.refresh_federated([an_entry("bob~annealing")])

    assert EngineRegistry.federated_entry("alice~tabu") is None
    assert EngineRegistry.federated_entry("bob~annealing") is not None


def test_a_built_in_engine_cannot_be_shadowed():
    # Not reachable in practice - a registered id always carries the owner
    # separator and a built-in id never can - but the precedence is stated
    # rather than left to dictionary ordering.
    EngineRegistry.refresh_federated([an_entry("random-search")])

    assert isinstance(EngineRegistry.get_transport("random-search"), BuiltinTransport)
    assert EngineRegistry.get_plugin("random-search").engine_id == "random-search"


# -- Visibility -------------------------------------------------------------


def test_a_private_engine_is_invisible_to_a_stranger():
    EngineRegistry.refresh_federated([an_entry(visibility=EngineVisibility.PRIVATE)])

    assert "alice~tabu" not in EngineRegistry.visible_engine_ids(FakeUser(uuid.uuid4()))


def test_a_private_engine_is_invisible_to_nobody_in_particular():
    EngineRegistry.refresh_federated([an_entry(visibility=EngineVisibility.PRIVATE)])

    assert "alice~tabu" not in EngineRegistry.visible_engine_ids(None)


def test_a_private_engine_is_visible_to_its_owner():
    owner = uuid.uuid4()
    EngineRegistry.refresh_federated([an_entry(owner_id=owner)])

    assert "alice~tabu" in EngineRegistry.visible_engine_ids(FakeUser(owner))


def test_a_private_engine_is_visible_to_an_administrator():
    # Somebody has to be able to review a registration before it is published.
    EngineRegistry.refresh_federated([an_entry()])

    assert "alice~tabu" in EngineRegistry.visible_engine_ids(
        FakeUser(uuid.uuid4(), is_admin=True)
    )


def test_a_public_engine_is_visible_to_everybody():
    EngineRegistry.refresh_federated([an_entry(visibility=EngineVisibility.PUBLIC)])

    assert "alice~tabu" in EngineRegistry.visible_engine_ids(None)


def test_an_engine_awaiting_review_is_not_public_yet():
    # Asking to be published is not being published.
    EngineRegistry.refresh_federated([an_entry(visibility=EngineVisibility.PENDING_REVIEW)])

    assert "alice~tabu" not in EngineRegistry.visible_engine_ids(None)


# -- Listing ----------------------------------------------------------------


def test_the_listing_marks_which_engines_are_somebody_elses():
    EngineRegistry.refresh_federated([an_entry(visibility=EngineVisibility.PUBLIC)])

    listing = {entry["id"]: entry for entry in EngineRegistry.list_engines()}

    assert listing["random-search"]["federated"] is False
    assert listing["alice~tabu"]["federated"] is True
    assert listing["alice~tabu"]["owner"] == "alice"
    assert listing["alice~tabu"]["status"] == "active"


def test_the_listing_hides_what_the_caller_may_not_see():
    EngineRegistry.refresh_federated([an_entry()])

    listed = {entry["id"] for entry in EngineRegistry.list_engines(FakeUser(uuid.uuid4()))}

    assert "alice~tabu" not in listed
    assert BUILT_INS <= listed


def test_every_listed_engine_carries_its_capabilities():
    EngineRegistry.refresh_federated([an_entry(visibility=EngineVisibility.PUBLIC)])

    assert all(entry["capabilities"] for entry in EngineRegistry.list_engines())


# -- Status -----------------------------------------------------------------


@pytest.mark.parametrize(
    "status,usable",
    [
        (EngineStatus.ACTIVE, True),
        (EngineStatus.DRAFT, False),
        (EngineStatus.VERIFYING, False),
        (EngineStatus.FAILED, False),
        (EngineStatus.DISABLED, False),
    ],
)
def test_only_a_verified_engine_may_be_solved_on(status, usable):
    assert an_entry(status=status).is_usable is usable
