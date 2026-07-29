"""Taking an instance apart and putting it back together, over HTTP.

The library already round-trips; what these check is that the endpoints expose
the same guarantee, and that a set of parts which cannot make one instance is
answered as a bad request rather than merged into something plausible.
"""

from __future__ import annotations

import glob
import json
import os

import pytest
from fastapi.testclient import TestClient

from openbinding_gateway.main import app

client = TestClient(app)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def every_instance() -> list:
    paths = [
        path
        for path in sorted(
            glob.glob(os.path.join(REPO_ROOT, "examples", "**", "*.json"), recursive=True)
        )
        if f"{os.sep}parts{os.sep}" not in path
    ]
    assert paths, "no instances found to round-trip"
    return paths


@pytest.mark.parametrize("path", every_instance())
def test_split_then_compose_is_the_identity_over_http(path: str) -> None:
    with open(path) as handle:
        instance = json.load(handle)

    split = client.post("/v1/instance/split", json={"instance": instance})
    assert split.status_code == 200, split.text
    parts = split.json()["parts"]

    composed = client.post("/v1/instance/compose", json={"parts": parts})
    assert composed.status_code == 200, composed.text
    assert composed.json()["instance"] == instance


def test_split_groups_the_parts_by_model() -> None:
    with open(os.path.join(REPO_ROOT, "examples", "demo", "01_simple_seq.json")) as handle:
        instance = json.load(handle)

    groups = client.post("/v1/instance/split", json={"instance": instance}).json()["groups"]

    assert groups["M_A"] == ["tasks", "composition", "aggregation-policies"]
    assert "candidates" in groups["M_C"]
    assert groups["Delta"] == ["constraints"]
    assert groups["O"] == ["objective"]
    assert "metadata" in groups["other"] and "normalization" in groups["other"]


def test_a_key_given_by_two_parts_is_refused() -> None:
    parts = {
        "tasks": {"tasks": [{"id": "t1", "name": "Task"}]},
        "composition": {"tasks": [{"id": "t1", "name": "Task"}]},
    }
    response = client.post("/v1/instance/compose", json={"parts": parts})

    assert response.status_code == 422
    assert "tasks" in response.json()["detail"]


def test_an_unknown_part_is_refused() -> None:
    response = client.post("/v1/instance/compose", json={"parts": {"whatever": {"tasks": []}}})

    assert response.status_code == 422
    assert "whatever" in response.json()["detail"]


def test_splitting_a_document_with_a_stray_key_is_refused() -> None:
    response = client.post("/v1/instance/split", json={"instance": {"not_a_part": 1}})

    assert response.status_code == 422
    assert "not_a_part" in response.json()["detail"]
