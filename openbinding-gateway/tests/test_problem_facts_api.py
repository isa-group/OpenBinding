"""The facts of a compiled problem over HTTP: ``getProblemCompilationFacts`` and ``validateBimPackage?include=facts``.

A stored compilation and the same package validated as a draft answer the same facts, and both bodies
satisfy the schemas the OpenAPI document publishes.
"""

from __future__ import annotations

import jsonschema
import pytest

from _b1_helpers import gate, make_account  # noqa: F401
from _problem_helpers import ZIP, package_bytes, upload_problem
from _repo import REPO_ROOT
from openbinding_gateway.main import app
from openbinding_gateway.modules.problems.application import facts as facts_module

pytestmark = pytest.mark.asyncio

VALIDATE = "/v1/bim/validate"
FMS = REPO_ROOT / "examples" / "demo" / "13_fms"


def _facts_url(uploaded: dict, compilation: str, revision: str | None = None) -> str:
    return (
        f"/v1/organizations/{uploaded['org']}/problems/{uploaded['problem']['slug']}"
        f"/revisions/{revision or uploaded['revision_id']}/compilations/{compilation}/facts"
    )


def _assert_component(component: str, payload: dict) -> None:
    jsonschema.Draft202012Validator(
        {"$ref": f"#/components/schemas/{component}", "components": app.openapi()["components"]}
    ).validate(payload)


async def test_the_facts_of_a_compilation_by_id_and_by_digest_with_an_immutable_etag(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    uploaded = await upload_problem(api_client, headers, path=FMS)
    compilation = uploaded["compilation"]

    by_id = await api_client.get(_facts_url(uploaded, compilation["id"]), headers=headers)
    assert by_id.status_code == 200, by_id.text
    tag = f'"{compilation["compilation_digest"]}.package.facts"'
    assert by_id.headers["etag"] == tag
    assert by_id.headers["cache-control"] == "private, immutable"
    body = by_id.json()
    assert body["ir_digest"] == compilation["ir_digest"]
    assert body["binding_space"] == compilation["binding_space"]
    assert {task["id"]: task["kind"] for task in body["tasks"]}["node_classic_routing"] == "local"
    assert body["workflow"]["seq"][3] == {"xor": [
        {"probability": 0.8, "flow": "node_classic_routing"}, {"probability": 0.2, "flow": "T5"},
    ]}

    by_digest = await api_client.get(_facts_url(uploaded, compilation["compilation_digest"]), headers=headers)
    assert by_digest.status_code == 200, by_digest.text
    assert by_digest.json() == body and by_digest.headers["etag"] == tag

    unchanged = await api_client.get(_facts_url(uploaded, compilation["id"]), headers={**headers, "If-None-Match": tag})
    assert unchanged.status_code == 304
    assert unchanged.headers["etag"] == tag and unchanged.content == b""
    listed = await api_client.get(
        _facts_url(uploaded, compilation["id"]), headers={**headers, "If-None-Match": f'"other", {tag}'}
    )
    assert listed.status_code == 304
    stale = await api_client.get(_facts_url(uploaded, compilation["id"]), headers={**headers, "If-None-Match": '"other"'})
    assert stale.status_code == 200


async def test_a_compilation_of_another_revision_or_unknown_is_not_found_and_a_non_member_is_forbidden(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    uploaded = await upload_problem(api_client, headers)
    second = await api_client.post(
        f"/v1/organizations/{uploaded['org']}/problems/{uploaded['problem']['slug']}/revisions",
        content=package_bytes(FMS),
        headers={**headers, **ZIP},
    )
    assert second.status_code == 201, second.text
    other = second.json()["compilation"]

    for reference in (other["id"], other["compilation_digest"], "not-a-reference", "00000000-0000-4000-8000-000000000000"):
        missing = await api_client.get(_facts_url(uploaded, reference), headers=headers)
        assert missing.status_code == 404, (reference, missing.text)
        assert missing.json()["code"] == "not_found"
    found = await api_client.get(_facts_url(uploaded, other["id"], second.json()["revision"]["id"]), headers=headers)
    assert found.status_code == 200, found.text

    _, outsider = await make_account(api_client, registration, db_session, gate)
    refused = await api_client.get(_facts_url(uploaded, uploaded["compilation"]["id"]), headers=outsider)
    assert refused.status_code == 403, refused.text
    anonymous = await api_client.get(_facts_url(uploaded, uploaded["compilation"]["id"]))
    assert anonymous.status_code == 401


async def test_validating_the_same_package_answers_the_stored_facts(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    uploaded = await upload_problem(api_client, headers, path=FMS)
    stored = await api_client.get(_facts_url(uploaded, uploaded["compilation"]["id"]), headers=headers)
    assert stored.status_code == 200, stored.text

    drafted = await api_client.post(VALIDATE, params={"include": "facts"}, content=package_bytes(FMS), headers=ZIP)
    assert drafted.status_code == 200, drafted.text
    body = drafted.json()
    assert body["facts"] == stored.json()
    assert "ir" not in body and "sourceMap" not in body
    _assert_component("AnalysisResult", body)
    _assert_component("ProblemFactsView", stored.json())


async def test_include_is_a_comma_list_over_ir_and_facts(api_client):
    both = await api_client.post(VALIDATE, params={"include": "ir,facts"}, content=package_bytes(), headers=ZIP)
    assert both.status_code == 200, both.text
    body = both.json()
    assert body["ir"]["kind"] == "BindingProblem" and isinstance(body["sourceMap"], dict)
    assert body["facts"]["ir_digest"] == body["irDigest"]
    _assert_component("AnalysisResult", body)

    only_ir = (await api_client.post(VALIDATE, params={"include": "ir"}, content=package_bytes(), headers=ZIP)).json()
    assert "ir" in only_ir and "facts" not in only_ir
    for bogus in ("bogus", "ir,bogus", "ir,", ""):
        refused = await api_client.post(VALIDATE, params={"include": bogus}, content=package_bytes(), headers=ZIP)
        assert refused.status_code == 422, (bogus, refused.text)
        assert refused.json()["code"] == "validation_error"


async def test_a_compilation_the_facts_cannot_read_is_a_422_with_the_reason(
    api_client, registration, db_session, gate, monkeypatch  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    uploaded = await upload_problem(api_client, headers)
    # Stored compilations are immutable, so the reader is handed the IR without its application instead.
    real = facts_module.facts_view

    def without_application(ir, *arguments, **keywords):
        spec = {key: value for key, value in ir["spec"].items() if key != "application"}
        return real({**ir, "spec": spec}, *arguments, **keywords)

    monkeypatch.setattr(facts_module, "facts_view", without_application)

    refused = await api_client.get(_facts_url(uploaded, uploaded["compilation"]["id"]), headers=headers)
    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "problem_facts_unreadable"
    assert "application" in refused.json()["reason"]
    drafted = await api_client.post(VALIDATE, params={"include": "facts"}, content=package_bytes(), headers=ZIP)
    assert drafted.status_code == 422, drafted.text
    assert drafted.json()["code"] == "problem_facts_unreadable"


async def test_a_generated_revision_has_other_facts_than_the_same_bytes_uploaded(
    api_client, registration, db_session, gate  # noqa: F811
):
    from openbinding_gateway.modules.problems.application import create_problem
    from problems._sphere_helpers import flagship, member

    headers, org, organization, user = await member(api_client, registration, db_session, gate)
    generated = flagship()
    uploaded = await upload_problem(api_client, headers, org, archive=generated.archive(), slug="uploaded")
    made = await create_problem(db_session, organization, generated.archive(), user, slug="generated",
                                value_origins=generated.origins)
    await db_session.commit()
    assert made.compilation.compilation_digest == uploaded["compilation"]["compilation_digest"]

    plain = await api_client.get(_facts_url(uploaded, uploaded["compilation"]["id"]), headers=headers)
    url = f"/v1/organizations/{org}/problems/generated/revisions/1/compilations/{made.compilation.id}/facts"
    rich = await api_client.get(url, headers=headers)
    assert plain.status_code == rich.status_code == 200, rich.text
    assert plain.headers["etag"].endswith('.package.facts"')
    assert rich.headers["etag"] != plain.headers["etag"] and rich.headers["etag"].startswith(
        f'"{made.compilation.compilation_digest}.sha256-'
    )
    unchanged = await api_client.get(url, headers={**headers, "If-None-Match": rich.headers["etag"]})
    assert unchanged.status_code == 304
    stale = await api_client.get(url, headers={**headers, "If-None-Match": plain.headers["etag"]})
    assert stale.status_code == 200

    body = rich.json()
    _assert_component("ProblemFactsView", body)
    candidate = next(c for c in body["candidates"] if c["key"] == "sphere-email/email.mailgun.foundation")
    assert candidate["properties"] == {"emailsPerDay": 100000000, "emailsPerMonth": 50000}
    assert candidate["origins"]["subscription"]["source"]["kind"] == "priced"
    assert candidate["origins"]["subscription"]["source"]["pricing"]["plan"] == "FOUNDATION"
    assert candidate["propertyOrigins"]["emailsPerMonth"]["source"]["kind"] == "limit"
    assert candidate["propertyOrigins"]["emailsPerMonth"]["pointer"].endswith("/properties/emailsPerMonth")
    assert candidate["provenance"]["sphere"] == "danruilop1/mailgun"
    postfix = next(c for c in body["candidates"] if c["key"] == "catalog/email.selfhosted.postfix")
    assert postfix["provenance"] is None and postfix["origins"]["latency"]["source"] is None
    assert postfix["properties"] == {"emailsPerDay": 100000000, "emailsPerMonth": 100000000}
    without = plain.json()
    assert all(c["provenance"] is None for c in without["candidates"])
