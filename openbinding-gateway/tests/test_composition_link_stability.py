"""A sealed version's link survives a toolchain release that reads the problem alike (F1 B11).

Plan §10: "enlace estable ante un cambio simulado de compilador con el mismo ``semantic_digest``". A version is
sealed under the real toolchain, then the installed toolchain is replaced: ``OtherToolchain`` is another
release that reads every problem alike (same semantic digest), ``SemanticChange`` one that reads them
differently. Re-evaluating stores one evaluation per release, whatever its outcome, and the version itself
never changes.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select, update

from _b1_helpers import gate, make_account  # noqa: F401
from _composition_helpers import (
    OTHER_COMPILER,
    SEMANTIC_COMPILER,
    CountingPort,
    OtherToolchain,
    SemanticChange,
    document_for,
    linked_problem,
)
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.db.models import AuditEvent, BindingCase, CompositionEvaluation, User
from openbinding_gateway.integrations import bim

YAML = {"content-type": "application/yaml"}
SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}


def code(response) -> str:
    body = response.json()
    return body["detail"]["code"] if isinstance(body.get("detail"), dict) else body["code"]


async def sealed_version(api_client, registration, db_session, gate):  # noqa: F811
    """An OWNER of an organization whose composition ``shop`` has one linked version, sealed by the real toolchain."""
    account, headers = await make_account(api_client, registration, db_session, gate)
    user = await db_session.get(User, uuid.UUID(account["id"]))
    linked = await linked_problem(db_session, user)
    await db_session.commit()
    base = f"/v1/organizations/{linked.organization.slug}/compositions"
    created = await api_client.post(base, headers=headers, json={"slug": "shop", "name": "Shop"})
    assert created.status_code == 201, created.text
    base = f"{base}/shop"
    source = document_for(linked, SIMPLE_BINDING)
    sealed = await api_client.post(f"{base}/versions", content=source.encode(), headers={**headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    return headers, linked, base, source, sealed.json()["version"]


async def evaluations(db_session) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(CompositionEvaluation)) or 0)


async def test_a_release_that_reads_the_problem_alike_is_evaluated_on_the_stored_link(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base, source, version = await sealed_version(api_client, registration, db_session, gate)
    content = (await api_client.get(f"{base}/versions/1/content", headers=headers)).text
    port = CountingPort(OtherToolchain(bim.get_bim()))

    with bim.bim_override(port):
        first = await api_client.post(f"{base}/versions/1/evaluations", headers=headers)
        again = await api_client.post(f"{base}/versions/{version['label']}/evaluations", headers=headers)
        shown = await api_client.get(f"{base}/versions/1", headers=headers)
        checked = await api_client.post(f"{base}/versions/check", content=source.encode(), headers={**headers, **YAML})

    assert first.status_code == 201, first.text
    evaluation = first.json()
    compiled = evaluation["compilation"]
    assert evaluation["basis"] == "bim" and evaluation["outcome"] == "verified"
    assert compiled["compiler_digest"] == OTHER_COMPILER
    assert compiled["compilation_digest"] != linked.compilation.compilation_digest
    assert compiled["semantic_digest"] == linked.compilation.semantic_digest
    assert [(item["code"], item["severity"], item["path"]) for item in evaluation["diagnostics"]] == [
        (codes.COMPILATION_SUPERSEDED, "info", "problem.compilation"),
    ]
    # Located in the version's own content, which names the linked compilation.
    span = evaluation["diagnostics"][0]["span"]
    assert span is not None
    assert linked.compilation.compilation_digest in content.splitlines()[span["line"] - 1]
    assert evaluation["values"] == version["values"]
    assert evaluation["current"] is True

    assert again.status_code == 200, again.text
    assert again.json()["id"] == evaluation["id"]
    assert port.calls["evaluate"] == 2  # the first re-evaluation and the check; the repeat asks nothing

    view = shown.json()
    assert view["current_evaluation_id"] == evaluation["id"] and view["verified"] is True
    assert [item["compilation"]["compiler_digest"] for item in view["evaluations"]] == [
        linked.compilation.compiler_digest, OTHER_COMPILER,
    ]
    assert view["content_digest"] == version["content_digest"]
    assert view["problem"]["linked_compilation"]["id"] == str(linked.compilation.id)
    assert (await api_client.get(f"{base}/versions/1/content", headers=headers)).text == content
    assert await evaluations(db_session) == 2
    audited = (await db_session.scalars(
        select(AuditEvent).where(AuditEvent.action == "composition.version_evaluated")
    )).all()
    assert [event.detail["basis_key"] for event in audited] == [OTHER_COMPILER]

    assert checked.status_code == 200, checked.text
    assert checked.json()["valid"] is True
    assert [item["code"] for item in checked.json()["diagnostics"]] == [codes.COMPILATION_SUPERSEDED]


async def test_the_installed_toolchains_evaluation_exists_already(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base, _, version = await sealed_version(api_client, registration, db_session, gate)
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        response = await api_client.post(f"{base}/versions/1/evaluations", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["id"] == version["current_evaluation_id"]
    assert port.calls["evaluate"] == 0 and port.calls["compile"] == 0


async def test_a_renamed_problem_does_not_break_the_stored_link(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base, _, _ = await sealed_version(api_client, registration, db_session, gate)
    await db_session.execute(
        update(BindingCase).where(BindingCase.id == linked.upload.problem.id).values(slug="renamed")
    )
    await db_session.commit()

    with bim.bim_override(OtherToolchain(bim.get_bim())):
        response = await api_client.post(f"{base}/versions/1/evaluations", headers=headers)

    assert response.status_code == 201, response.text
    assert response.json()["outcome"] == "verified"


async def test_a_release_that_reads_the_problem_differently_is_stored_and_refuses_new_seals(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base, source, version = await sealed_version(api_client, registration, db_session, gate)

    with bim.bim_override(SemanticChange(bim.get_bim())):
        stored = await api_client.post(f"{base}/versions/1/evaluations", headers=headers)
        shown = await api_client.get(f"{base}/versions/1", headers=headers)
        resealed = await api_client.post(
            f"{base}/versions", content=source.replace("version: 1.0.0", "version: 1.0.1").encode(),
            headers={**headers, **YAML},
        )

    assert stored.status_code == 201, stored.text
    evaluation = stored.json()
    assert evaluation["outcome"] == "semantics_changed" and evaluation["values"] == {}
    assert evaluation["compilation"]["compiler_digest"] == SEMANTIC_COMPILER
    assert evaluation["compilation"]["semantic_digest"] != linked.compilation.semantic_digest
    assert [(item["code"], item["path"]) for item in evaluation["diagnostics"]] == [
        (codes.COMPILATION_SEMANTICS_CHANGED, "problem.compilation"),
    ]
    view = shown.json()
    assert view["current_evaluation_id"] == evaluation["id"] and view["verified"] is False
    assert view["content_digest"] == version["content_digest"]

    assert resealed.status_code == 422, resealed.text
    assert code(resealed) == "composition_invalid"
    assert [item["code"] for item in resealed.json()["diagnostics"]] == [codes.COMPILATION_SEMANTICS_CHANGED]


async def test_a_member_re_evaluates_and_a_viewer_does_not(api_client, registration, db_session, gate):  # noqa: F811
    from _b1_helpers import put_member

    headers, linked, base, _, _ = await sealed_version(api_client, registration, db_session, gate)
    viewer_account, viewer = await make_account(api_client, registration, db_session, gate)
    added = await put_member(api_client, headers, linked.organization.slug, viewer_account["id"], "VIEWER")
    assert added.status_code in (200, 201), added.text
    _, outsider = await make_account(api_client, registration, db_session, gate)

    with bim.bim_override(OtherToolchain(bim.get_bim())):
        weak = await api_client.post(f"{base}/versions/1/evaluations", headers=viewer)
        unseen = await api_client.post(f"{base}/versions/1/evaluations", headers=outsider)
        missing = await api_client.post(f"{base}/versions/9/evaluations", headers=headers)

    assert weak.status_code == 403 and code(weak) == "organization_forbidden"
    assert unseen.status_code == 404 and code(unseen) == "not_found"
    assert missing.status_code == 404 and code(missing) == "not_found"
    assert await evaluations(db_session) == 1
