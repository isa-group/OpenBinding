"""The composition diff, served: the operation exists as an endpoint, not only as a function.

The repository's standing rule is that every operation the web interface can reach is also
a documented API endpoint. Phase F1 step 6 produced one -- comparing two versions of a
composition -- and this is where it stops being a library function only.

It takes the two sources rather than naming two stored versions because **nothing stores a
composition yet**: phases F0 and F1 built the language, not its storage. An endpoint shaped
``/compositions/{id}/diff?from=&to=`` would have had to invent persistence to have anything
to read. When that storage arrives, the stored-version form is an addition and the response
body does not change, which is the property the last test here pins.
"""

from __future__ import annotations

import pytest

BEFORE = """
composition: fleet
version: "1.0.0"
properties:
  cost:
    unit: USD/month
    direction: minimize
    domain: {min: 0, max: 10000}
    aggregate:
      sequence: sum
      parallel: sum
      exclusive: weightedSum
      repeat: scale
      selection: sum
tasks:
  pick: {open: true, requires: service/pick}
  pay: {open: true, requires: service/pay}
workflow:
  sequence:
    - {task: pick}
    - {task: pay}
candidates:
  rows:
    - id: c_pick
      provides: service/pick
      properties: {cost: 10}
goals:
  - property: cost
    normalize: {min: 0, max: 10000}
"""

#: The same composition with one task renamed and the goal's range moved. The first is the
#: change the compare screen reports as a removal plus an addition; the second is the one it
#: reports as *Same*.
AFTER = BEFORE.replace("  pick: {open: true, requires: service/pick}", "  collect: {open: true, requires: service/pick}") \
              .replace("    - {task: pick}", "    - {task: collect}") \
              .replace("normalize: {min: 0, max: 10000}", "normalize: {min: 0, max: 25000}")


async def test_two_identical_compositions_report_no_changes(api_client) -> None:
    """An empty change list is a verdict here, not a shrug: ``identical`` says so."""
    response = await api_client.post(
        "/v1/compositions/diff", json={"before": BEFORE, "after": BEFORE},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["identical"] is True
    assert body["changes"] == []
    assert set(body["counts"]) == {
        "identity", "properties", "tasks", "workflow", "candidates", "placement", "rules",
        "goals", "studio",
    }
    assert sum(body["counts"].values()) == 0


async def test_a_rename_and_a_moved_range_are_both_reported(api_client) -> None:
    """The two changes the existing compare screen gets wrong, over the wire."""
    response = await api_client.post(
        "/v1/compositions/diff", json={"before": BEFORE, "after": AFTER},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["identical"] is False
    found = {(change["section"], change["subject"], change["kind"]) for change in body["changes"]}
    assert ("tasks", "pick", "renamed") in found
    assert ("goals", "cost.normalize", "changed") in found
    # A rename is one change, not a removal plus an addition.
    assert not [c for c in body["changes"] if c["kind"] in {"added", "removed"} and c["section"] == "tasks"]
    assert body["counts"]["tasks"] == 1
    assert body["counts"]["goals"] == 1

    moved = next(c for c in body["changes"] if c["subject"] == "cost.normalize")
    assert moved["was"] == {"min": 0, "max": 10000, "clamp": True}
    assert moved["now"] == {"min": 0, "max": 25000, "clamp": True}


async def test_a_document_that_is_not_a_composition_is_the_caller_s_mistake(api_client) -> None:
    """422 with the side that failed named, not a 500."""
    response = await api_client.post(
        "/v1/compositions/diff", json={"before": BEFORE, "after": "composition: fleet\n"},
    )
    assert response.status_code == 422
    assert "after" in str(response.json())

    broken = await api_client.post(
        "/v1/compositions/diff", json={"before": "{not: [valid", "after": BEFORE},
    )
    assert broken.status_code == 422
    assert "before" in str(broken.json())


async def test_the_request_refuses_what_it_does_not_understand(api_client) -> None:
    """A misspelled field is a refusal rather than a silently ignored one."""
    response = await api_client.post(
        "/v1/compositions/diff",
        json={"before": BEFORE, "after": BEFORE, "from": "1.0.0"},
    )
    assert response.status_code == 422


async def test_no_account_is_required_because_nothing_is_read_or_written(api_client) -> None:
    """The response is a pure function of the request, so there is nothing to protect."""
    response = await api_client.post(
        "/v1/compositions/diff", json={"before": BEFORE, "after": AFTER},
    )
    assert response.status_code == 200


@pytest.mark.parametrize("field", ["before", "after"])
async def test_both_operands_are_required(api_client, field: str) -> None:
    payload = {"before": BEFORE, "after": BEFORE}
    payload.pop(field)
    response = await api_client.post("/v1/compositions/diff", json=payload)
    assert response.status_code == 422


async def test_the_operation_is_documented(api_client) -> None:
    """The rule is that the operation is documented, not merely reachable."""
    response = await api_client.get("/openapi.json")
    paths = response.json()["paths"]
    assert "/v1/compositions/diff" in paths
    operation = paths["/v1/compositions/diff"]["post"]
    assert operation["operationId"] == "diffCompositions"
    assert operation["summary"]
    assert "422" in operation["responses"]
