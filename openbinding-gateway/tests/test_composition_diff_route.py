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


# ------------------------------------------------------------------------- validation

#: ``BEFORE`` is a draft: task ``pay`` has no candidate. It is the very fixture that split the
#: semantic checks in two, so it stays one, and this is the same composition finished.
COMPLETE = BEFORE.replace(
    "      properties: {cost: 10}",
    "      properties: {cost: 10}\n"
    "    - id: c_pay\n"
    "      provides: service/pay\n"
    "      properties: {cost: 20}",
)


async def test_a_complete_composition_is_valid_and_complete(api_client) -> None:
    """The answer an editor hopes for, and the one with no diagnostics at all."""
    response = await api_client.post("/v1/compositions/validate", json={"source": COMPLETE})
    assert response.status_code == 200
    body = response.json()
    assert (body["valid"], body["complete"], body["diagnostics"]) == (True, True, [])


async def test_a_draft_is_valid_and_incomplete_at_once(api_client) -> None:
    """The case the whole split exists for, over the wire.

    An open task whose market is not written yet is a normal state while authoring: the
    document reads, the editor keeps working, and the marker says what is missing before a
    version can be sealed. ``incomplete`` and not ``error``, and 200 and not 422.
    """
    response = await api_client.post("/v1/compositions/validate", json={"source": BEFORE})
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["complete"] is False
    codes = {(item["code"], item["severity"]) for item in body["diagnostics"]}
    assert ("c2y_candidate_unmatched", "incomplete") in codes
    pay = next(item for item in body["diagnostics"] if item["path"] == "tasks.pay")
    assert pay["span"] is not None, "located, so an editor can underline the task"


async def test_an_incoherent_document_is_an_error_with_its_position(api_client) -> None:
    """Probabilities that do not sum to one cannot be a step on the way to a valid document."""
    broken = BEFORE.replace(
        "  sequence:\n    - {task: pick}\n    - {task: pay}",
        "  sequence:\n    - exclusive:\n        id: choice\n        branches:\n"
        "          - {probability: 0.7, flow: {task: pick}}\n"
        "          - {probability: 0.2, flow: {task: pay}}",
    )
    response = await api_client.post("/v1/compositions/validate", json={"source": broken})
    assert response.status_code == 200
    body = response.json()
    assert (body["valid"], body["complete"]) == (False, False)
    first = body["diagnostics"][0]
    assert (first["code"], first["severity"]) == ("c2y_exclusive_probabilities", "error")


async def test_text_that_is_not_yaml_is_located_where_the_parser_gave_up(api_client) -> None:
    """The commonest state of a document being typed, so it is placed like everything else."""
    response = await api_client.post(
        "/v1/compositions/validate", json={"source": "composition: fleet\n  version: [broken"},
    )
    assert response.status_code == 200
    first = response.json()["diagnostics"][0]
    assert first["code"] == "c2y_syntax"
    assert first["span"] is not None and first["span"]["line"] == 2


async def test_validation_answers_200_whatever_the_document_says(api_client) -> None:
    """A deliberate departure from ``POST /v1/validate``, which answers 422 for a bad package.

    The request always succeeds; the answer may be that the text has problems. Splitting the
    status by severity would give an editor two response shapes for one question it asks
    after every keystroke -- and one of the two severities is not an error at all.
    """
    for source in (COMPLETE, BEFORE, "composition: fleet\n", "{not: [valid"):
        response = await api_client.post("/v1/compositions/validate", json={"source": source})
        assert response.status_code == 200, (source, response.text)


async def test_a_malformed_request_is_still_the_caller_s_mistake(api_client) -> None:
    """The document may be anything; the request around it is not."""
    missing = await api_client.post("/v1/compositions/validate", json={})
    assert missing.status_code == 422
    unknown = await api_client.post(
        "/v1/compositions/validate", json={"source": COMPLETE, "strict": True},
    )
    assert unknown.status_code == 422


async def test_validation_is_documented(api_client) -> None:
    response = await api_client.get("/openapi.json")
    operation = response.json()["paths"]["/v1/compositions/validate"]["post"]
    assert operation["operationId"] == "validateComposition"
    assert operation["summary"]
