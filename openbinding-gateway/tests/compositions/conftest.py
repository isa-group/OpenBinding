"""Fixtures of the F6 watcher tests: the two clocks and a pricing source on them over the recorded SPHERE."""

from __future__ import annotations

import pytest

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.modules.plans.adapters.sphere import SphereHttpSource

from ._watching import Clocks


@pytest.fixture
def clocks(monkeypatch) -> Clocks:
    return Clocks(monkeypatch)


@pytest.fixture
def source(sphere, clocks: Clocks) -> SphereHttpSource:
    return SphereHttpSource(get_settings().model_copy(update={"sphere_enabled": True}), transport=sphere.transport(),
                            clock=clocks)
