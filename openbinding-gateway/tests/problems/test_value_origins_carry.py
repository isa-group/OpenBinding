"""Value origins carried into later revisions: a SPHERE badge never survives a hand edit, and never disappears
without one."""

from __future__ import annotations

import json

import pytest

from _b1_helpers import gate  # noqa: F401
from _problem_helpers import package_bytes
from _repo import REPO_ROOT
from openbinding_gateway.integrations.packages import zip_files
from openbinding_gateway.modules.problems.application import (
    add_revision,
    candidate_provenance,
    create_problem,
    origins_for,
)
from openbinding_gateway.modules.problems.application import problems as problems_module
from openbinding_gateway.modules.problems.application.sphere import dump

from problems._sphere_helpers import flagship, member

pytestmark = pytest.mark.asyncio

EDITOR = {"producer": "openbinding-problem-editor"}
FOUNDATION = "sphere-email/email.mailgun.foundation"


def _edited(change) -> bytes:
    files = dict(flagship().files)
    documents = {path: json.loads(content) for path, content in files.items()}
    change(documents)
    return zip_files({path: dump(document) for path, document in documents.items()})


def _candidate(documents, identifier):
    return documents["sphere-email.json"]["spec"]["candidates"][identifier]


async def _generated(api_client, registration, db_session, gate):  # noqa: F811
    _, _, organization, user = await member(api_client, registration, db_session, gate)
    generated = flagship()
    upload = await create_problem(db_session, organization, generated.archive(), user, slug="tomatometer-email",
                                  value_origins=generated.origins)
    return upload, user, await origins_for(db_session, upload.revision.id)


def _keyed(rows):
    return {(r.candidate_key, r.target_kind, r.target): r for r in rows}


async def test_a_save_that_changes_only_an_objective_keeps_every_row(api_client, registration, db_session, gate):  # noqa: F811
    upload, user, before = await _generated(api_client, registration, db_session, gate)

    def objective(documents):
        documents["optimization.json"]["spec"]["criteria"][2]["normalize"]["max"] = 3000

    saved = await add_revision(db_session, upload.problem, _edited(objective), user, provenance=EDITOR)
    assert saved.created and saved.revision.revision == 2 and saved.revision.origin == "editor"
    after = await origins_for(db_session, saved.revision.id)
    assert set(_keyed(after)) == set(_keyed(before))
    assert all(r.carried_from_revision_id == upload.revision.id for r in after)
    first = _keyed(before)
    assert all(r.snapshot_id == first[k].snapshot_id and r.version_id == first[k].version_id for k, r in _keyed(after).items())
    assert set(await candidate_provenance(db_session, saved.revision.id)) == set(
        await candidate_provenance(db_session, upload.revision.id)
    )


async def test_editing_a_manual_value_drops_only_that_row(api_client, registration, db_session, gate):  # noqa: F811
    upload, user, before = await _generated(api_client, registration, db_session, gate)

    def latency(documents):
        _candidate(documents, "email.mailgun.foundation")["features"]["latency"] = 210

    saved = await add_revision(db_session, upload.problem, _edited(latency), user, provenance=EDITOR)
    after = _keyed(await origins_for(db_session, saved.revision.id))
    assert set(_keyed(before)) - set(after) == {(FOUNDATION, "feature", "latency")}
    # A manual value is not a pricing's: the candidate keeps its provenance.
    assert FOUNDATION in await candidate_provenance(db_session, saved.revision.id)


async def test_editing_a_priced_value_drops_the_row_and_the_provenance(api_client, registration, db_session, gate):  # noqa: F811
    upload, user, before = await _generated(api_client, registration, db_session, gate)

    def price(documents):
        _candidate(documents, "email.mailgun.foundation")["features"]["subscription"] = 30

    saved = await add_revision(db_session, upload.problem, _edited(price), user, provenance=EDITOR)
    after = _keyed(await origins_for(db_session, saved.revision.id))
    assert (FOUNDATION, "feature", "subscription") not in after
    assert (FOUNDATION, "feature", "availability") in after  # its guarantee still holds, with its source
    provenance = await candidate_provenance(db_session, saved.revision.id)
    assert FOUNDATION not in provenance and "sphere-email/email.mailgun.scale" in provenance

    # And it stays lost: a later save that changes nothing about it carries the mark, not a provenance.
    def objective(documents):
        documents["optimization.json"]["spec"]["criteria"][0]["normalize"]["max"] = 2000
        _candidate(documents, "email.mailgun.foundation")["features"]["subscription"] = 30

    later = await add_revision(db_session, upload.problem, _edited(objective), user, provenance=EDITOR)
    assert FOUNDATION not in await candidate_provenance(db_session, later.revision.id)


async def test_removing_a_candidate_drops_its_rows(api_client, registration, db_session, gate):  # noqa: F811
    upload, user, before = await _generated(api_client, registration, db_session, gate)

    def remove(documents):
        del documents["sphere-email.json"]["spec"]["candidates"]["email.mailgun.foundation"]

    saved = await add_revision(db_session, upload.problem, _edited(remove), user, provenance=EDITOR)
    after = _keyed(await origins_for(db_session, saved.revision.id))
    assert not any(key[0] == FOUNDATION for key in after)
    assert len(after) == len(before) - sum(1 for r in before if r.candidate_key == FOUNDATION)


async def test_unrelated_bytes_carry_nothing_and_an_idempotent_revision_keeps_its_own(api_client, registration, db_session, gate):  # noqa: F811
    upload, user, before = await _generated(api_client, registration, db_session, gate)
    unrelated = await add_revision(db_session, upload.problem, package_bytes(REPO_ROOT / "examples" / "demo" / "01_simple_seq"), user)
    assert await origins_for(db_session, unrelated.revision.id) == []
    again = await add_revision(db_session, upload.problem, flagship().archive(), user)
    assert not again.created and again.revision.id == upload.revision.id
    assert len(await origins_for(db_session, upload.revision.id)) == len(before)


async def test_a_save_carries_from_the_revision_inserted_before_its_lock(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    upload, user, before = await _generated(api_client, registration, db_session, gate)
    real = problems_module._lock_account
    inserted = {}

    def price(documents):
        _candidate(documents, "email.mailgun.foundation")["features"]["subscription"] = 30

    def both(documents):
        price(documents)
        documents["optimization.json"]["spec"]["criteria"][2]["normalize"]["max"] = 3000

    async def concurrent_save(session, user_id):
        monkeypatch.setattr(problems_module, "_lock_account", real)
        inserted["revision"] = await add_revision(session, upload.problem, _edited(price), user, provenance=EDITOR)
        await real(session, user_id)

    monkeypatch.setattr(problems_module, "_lock_account", concurrent_save)
    saved = await add_revision(db_session, upload.problem, _edited(both), user, provenance=EDITOR)
    assert inserted["revision"].revision.revision == 2 and saved.revision.revision == 3
    after = await origins_for(db_session, saved.revision.id)
    assert after and all(r.carried_from_revision_id == inserted["revision"].revision.id for r in after)
    assert (FOUNDATION, "feature", "subscription") not in _keyed(after)
