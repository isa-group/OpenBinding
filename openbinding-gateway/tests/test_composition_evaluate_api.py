"""Evaluating another binding of a sealed version, and the neighbourhood of its binding (F1 B11).

Both read the version's stored bytes and the problem it links, evaluate on the installed toolchain's
compilation and store nothing. Every value, verdict and alternative is the in-process toolchain's own
answer, compared exactly; a ``CountingPort`` pins one toolchain call per request.
"""

from __future__ import annotations

import uuid
from contextlib import AsyncExitStack

from sqlalchemy import func, select

from _b1_helpers import gate, make_account, put_member  # noqa: F401
from _composition_helpers import CountingPort, OtherToolchain, bim_binding, document_for, linked_problem
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition.document import Provenance
from openbinding_gateway.core.settings import SphereRegistry, get_settings
from openbinding_gateway.db.models import CompositionEvaluation, User
from openbinding_gateway.integrations import bim
from openbinding_gateway.modules.compositions.application import evaluation_slot

YAML = {"content-type": "application/yaml"}
SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}

DECLARED = """\
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: workflow
workflow:
  seq: [t1, t2]
binding:
  t1: {candidate: c1a}
  t2: {local: true}
values:
  latency: {value: 30, unit: ms}
"""


def code(response) -> str:
    body = response.json()
    return body["detail"]["code"] if isinstance(body.get("detail"), dict) else body["code"]


def found(response) -> list[tuple[str, str, str]]:
    return [(item["code"], item["path"], item["pointer"]) for item in response.json()["diagnostics"]]


async def composition_of(api_client, registration, db_session, gate):  # noqa: F811
    """An OWNER of an organization with the problem ``01_simple_seq`` and an empty composition ``shop``."""
    account, headers = await make_account(api_client, registration, db_session, gate)
    user = await db_session.get(User, uuid.UUID(account["id"]))
    linked = await linked_problem(db_session, user)
    await db_session.commit()
    base = f"/v1/organizations/{linked.organization.slug}/compositions"
    created = await api_client.post(base, headers=headers, json={"slug": "shop", "name": "Shop"})
    assert created.status_code == 201, created.text
    return headers, linked, f"{base}/shop"


async def seal(api_client, headers, base, source: str) -> dict:
    sealed = await api_client.post(f"{base}/versions", content=source.encode(), headers={**headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    return sealed.json()["version"]


async def linked_version(api_client, registration, db_session, gate, **document):  # noqa: F811
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    version = await seal(api_client, headers, base, document_for(linked, SIMPLE_BINDING, **document))
    return headers, linked, base, version


async def evaluations(db_session) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(CompositionEvaluation)) or 0)


# --------------------------------------------------------------------------- another binding


async def test_another_binding_gets_the_toolchains_values_and_nothing_is_stored(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base, version = await linked_version(api_client, registration, db_session, gate)
    other = {**SIMPLE_BINDING, "t1": "c1b"}
    expected = bim.get_bim().evaluate(linked.compilation.ir, bim_binding(linked, other))
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        response = await api_client.post(f"{base}/evaluate", headers=headers, json={"binding": {"t1": "c1b"}})
        own = await api_client.post(f"{base}/evaluate", headers=headers, json={"version": "1.0.0"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == {"id": version["id"], "label": "1.0.0"}
    assert body["valid"] is True and body["violations"] == [] and body["diagnostics"] == []
    assert body["values"]["latency"]["value"] == expected["features"]["latency"]
    assert body["values"]["latency"]["unit"] == "ms"
    assert body["values"] != version["values"]
    assert own.status_code == 200, own.text
    assert own.json()["values"] == version["values"]
    assert port.calls["evaluate"] == 2 and port.calls["compile"] == 0
    assert await evaluations(db_session) == 1


async def test_a_binding_the_toolchain_cannot_take_is_refused_at_its_task_in_the_request(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, _, base, _ = await linked_version(api_client, registration, db_session, gate)
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        unknown = await api_client.post(f"{base}/evaluate", headers=headers, json={"binding": {"t1": "nope"}})
        untranslated = port.calls["evaluate"]
        no_task = await api_client.post(f"{base}/evaluate", headers=headers, json={"binding": {"zz": "c1a"}})
        malformed = await api_client.post(f"{base}/evaluate", headers=headers, json={"binding": {"t1": "a b"}})
        before = port.calls["evaluate"]
        not_allowed = await api_client.post(f"{base}/evaluate", headers=headers, json={"binding": {"t1": "c2a"}})

    assert unknown.status_code == 422, unknown.text
    assert code(unknown) == "evaluation_invalid"
    assert found(unknown) == [(codes.CANDIDATE_UNKNOWN, "binding.t1", "/binding/t1")]
    assert untranslated == 0
    assert no_task.status_code == 422 and found(no_task) == [(codes.BINDING_UNKNOWN_TASK, "binding.zz", "/binding/zz")]
    assert malformed.status_code == 422 and found(malformed) == [(codes.CANDIDATE_REF_INVALID, "binding.t1", "/binding/t1")]
    assert before == 0

    assert not_allowed.status_code == 422, not_allowed.text
    assert code(not_allowed) == "evaluation_invalid"
    assert found(not_allowed) == [
        (codes.BINDING_INVALID, "binding", "/binding"),
        (codes.CANDIDATE_NOT_ALLOWED, "binding.t1", "/binding/t1"),
    ]
    assert port.calls["evaluate"] == 1


async def test_a_declared_or_empty_composition_has_nothing_to_evaluate(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await composition_of(api_client, registration, db_session, gate)

    empty = await api_client.post(f"{base}/evaluate", headers=headers, json={})
    empty_around = await api_client.get(f"{base}/neighborhood", headers=headers)
    version = await seal(api_client, headers, base, DECLARED)
    port = CountingPort(bim.get_bim())
    with bim.bim_override(port):
        declared = await api_client.post(f"{base}/evaluate", headers=headers, json={"version": "1"})
        around = await api_client.get(f"{base}/neighborhood", headers=headers)
        again = await api_client.post(f"{base}/versions/1/evaluations", headers=headers)
    missing = await api_client.post(f"{base}/evaluate", headers=headers, json={"version": "9.9.9"})

    assert empty.status_code == 409 and code(empty) == "composition_empty"
    assert empty_around.status_code == 409 and code(empty_around) == "composition_empty"
    assert declared.status_code == 422 and code(declared) == "composition_not_linked"
    assert around.status_code == 422 and code(around) == "composition_not_linked"
    assert again.status_code == 200, again.text
    assert again.json()["id"] == version["current_evaluation_id"] and again.json()["basis"] == "declared"
    assert port.calls["evaluate"] == port.calls["neighborhood"] == port.calls["compile"] == 0
    assert missing.status_code == 404 and code(missing) == "not_found"


async def test_a_version_pinned_to_a_registry_that_left_the_settings_is_still_evaluated(
    api_client, registration, db_session, gate, monkeypatch,  # noqa: F811
):
    monkeypatch.setattr(get_settings(), "sphere_registries", {"onprem": SphereRegistry(url="https://sphere.onprem.example")})
    pinned = {"t1": Provenance(sphere="acme/maps", registry="onprem", version="v1", plan="pro")}
    headers, _, base, _ = await linked_version(api_client, registration, db_session, gate, sources=pinned)
    monkeypatch.setattr(get_settings(), "sphere_registries", {})

    evaluated = await api_client.post(f"{base}/evaluate", headers=headers, json={"binding": {"t1": "c1b"}})
    around = await api_client.get(f"{base}/neighborhood", headers=headers)
    with bim.bim_override(OtherToolchain(bim.get_bim())):
        stored = await api_client.post(f"{base}/versions/1/evaluations", headers=headers)

    assert evaluated.status_code == 200, evaluated.text
    assert around.status_code == 200, around.text
    assert stored.status_code == 201, stored.text


async def test_a_viewer_evaluates_and_an_outsider_sees_nothing(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base, _ = await linked_version(api_client, registration, db_session, gate)
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    added = await put_member(api_client, headers, linked.organization.slug, viewer["id"], "VIEWER")
    assert added.status_code in (200, 201), added.text
    _, outsider = await make_account(api_client, registration, db_session, gate)

    assert (await api_client.post(f"{base}/evaluate", headers=viewer_headers, json={})).status_code == 200
    assert (await api_client.get(f"{base}/neighborhood", headers=viewer_headers)).status_code == 200
    for response in (
        await api_client.post(f"{base}/evaluate", headers=outsider, json={}),
        await api_client.get(f"{base}/neighborhood", headers=outsider),
    ):
        assert response.status_code == 404 and code(response) == "not_found"


# --------------------------------------------------------------------------- the neighbourhood


async def test_the_neighbourhood_is_the_toolchains_with_each_move_named_as_a_document_names_it(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base, version = await linked_version(api_client, registration, db_session, gate)
    expected = bim.get_bim().neighborhood(
        linked.compilation.ir, bim_binding(linked, SIMPLE_BINDING), task="t1", limit=32, seconds=2.0,
    )
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        response = await api_client.get(f"{base}/neighborhood?task=t1", headers=headers)
        everything = await api_client.get(f"{base}/neighborhood?version=1.0.0&limit=128", headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == {"id": version["id"], "label": "1.0.0"}
    assert body["kind"] == "canonical-one-task-counterfactuals" and body["scope"] == "selected-service-task"
    assert body["task"] == "t1" and body["irDigest"] == expected["irDigest"]
    (move,) = body["moves"]
    (wanted,) = expected["moves"]
    assert move["task"] == "t1" and move["from"] == {"resource": wanted["from"]["resource"], "id": "c1a"}
    assert move["to"] == wanted["to"] and move["to"]["id"] == "c1b" and move["candidate"] == "c1b"
    assert move["comparison"] == wanted["comparison"] and move["objectives"] == wanted["objectives"]
    assert body["coverage"] == expected["coverage"]
    assert everything.status_code == 200, everything.text
    assert everything.json()["scope"] == "all-service-tasks"
    assert port.calls["neighborhood"] == 2 and port.calls["evaluate"] == 0 and port.calls["compile"] == 0


async def test_the_neighbourhood_refuses_what_the_toolchain_cannot_analyse(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, _, base, _ = await linked_version(api_client, registration, db_session, gate)

    no_limit = await api_client.get(f"{base}/neighborhood?limit=0", headers=headers)
    too_many = await api_client.get(f"{base}/neighborhood?limit=129", headers=headers)
    no_task = await api_client.get(f"{base}/neighborhood?task=zz", headers=headers)

    assert no_limit.status_code == 422 and too_many.status_code == 422
    assert no_task.status_code == 422 and code(no_task) == "analysis_invalid"


# --------------------------------------------------------------------------- bounded


async def test_a_held_evaluation_pool_refuses_all_three_with_429(
    api_client, registration, db_session, gate, monkeypatch,  # noqa: F811
):
    headers, _, base, _ = await linked_version(api_client, registration, db_session, gate)
    monkeypatch.setattr(get_settings(), "composition_evaluation_slots", 1)

    with bim.bim_override(OtherToolchain(bim.get_bim())):
        async with AsyncExitStack() as stack:
            await stack.enter_async_context(evaluation_slot())
            refused = [
                await api_client.post(f"{base}/versions/1/evaluations", headers=headers),
                await api_client.post(f"{base}/evaluate", headers=headers, json={}),
                await api_client.get(f"{base}/neighborhood", headers=headers),
            ]
        stored = await api_client.post(f"{base}/versions/1/evaluations", headers=headers)

    for response in refused:
        assert response.status_code == 429, response.text
        assert code(response) == "composition_busy" and response.headers["Retry-After"] == "1"
    assert stored.status_code == 201, stored.text
    assert await evaluations(db_session) == 2


async def test_a_re_evaluation_asks_the_toolchain_once(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base, _ = await linked_version(api_client, registration, db_session, gate)
    port = CountingPort(OtherToolchain(bim.get_bim()))

    with bim.bim_override(port):
        first = await api_client.post(f"{base}/versions/1/evaluations", headers=headers)
        asked = port.calls["evaluate"]
        second = await api_client.post(f"{base}/versions/1/evaluations", headers=headers)

    assert (first.status_code, second.status_code) == (201, 200)
    assert asked == 1 and port.calls["evaluate"] == 1
    assert port.calls["compile"] == 1  # the installed release's compilation of the revision, once
