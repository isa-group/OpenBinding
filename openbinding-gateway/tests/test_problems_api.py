"""The problems API: a problem belongs to an organization and is created by uploading a closed ``.bim.zip``."""

from __future__ import annotations

import io
import uuid
import zipfile

import pytest
from bim_core.canonical import digest_bytes
from sqlalchemy import func, select

from _b1_helpers import make_account, put_member, gate  # noqa: F401,F811
from _problem_helpers import EXAMPLE, ZIP, make_org, package_bytes, seed_problem_run, upload_problem
from openbinding_gateway.modules.problems.application import semantic_digest
from openbinding_gateway.space_client import PlanCaps
from openbinding_gateway.db.models import (
    BindingCase,
    BindingCaseRevision,
    Blob,
    Job,
    JobState,
    ProblemCompilation,
    User,
)

pytestmark = pytest.mark.asyncio


def rezipped(archive: bytes) -> bytes:
    """The same files in another archive: other bytes, the same package."""
    source = zipfile.ZipFile(io.BytesIO(archive))
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for name in reversed(source.namelist()):
            target.writestr(name, source.read(name))
    return output.getvalue()


async def count(db, model) -> int:
    return int(await db.scalar(select(func.count()).select_from(model)) or 0)


async def owner(api_client, registration, db_session, gate):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    return account, headers, await make_org(api_client, headers)


async def test_an_upload_creates_the_problem_its_first_revision_one_compilation_and_one_blob(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    archive = package_bytes()

    response = await api_client.post(f"/v1/organizations/{org}/problems", content=archive, headers={**headers, **ZIP})

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["created"] is True
    assert body["revision"]["revision"] == 1
    assert body["revision"]["package_size"] == len(archive)
    assert body["problem"]["latest_revision"]["id"] == body["revision"]["id"]
    assert body["compilation"]["current"] is True
    assert body["compilation"]["semantic_digest"].startswith("sha256-")
    assert (await count(db_session, BindingCase), await count(db_session, BindingCaseRevision)) == (1, 1)
    assert (await count(db_session, ProblemCompilation), await count(db_session, Blob)) == (1, 1)
    blob = await db_session.scalar(select(Blob))
    assert blob.digest == digest_bytes(archive)


async def test_the_slug_defaults_from_the_instance_name_and_a_taken_one_is_a_409(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    first = await api_client.post(f"/v1/organizations/{org}/problems", content=package_bytes(), headers={**headers, **ZIP})
    assert first.status_code == 201, first.text
    slug = first.json()["problem"]["slug"]
    assert slug and slug == slug.lower()

    again = await api_client.post(f"/v1/organizations/{org}/problems", content=package_bytes(), headers={**headers, **ZIP})
    explicit = await api_client.post(
        f"/v1/organizations/{org}/problems", params={"slug": slug}, content=package_bytes(), headers={**headers, **ZIP},
    )

    assert again.status_code == 409 and again.json()["detail"]["code"] == "slug_conflict"
    assert explicit.status_code == 409 and explicit.json()["detail"]["code"] == "slug_conflict"
    assert await count(db_session, BindingCase) == 1


async def test_the_same_package_again_is_the_same_revision_even_rezipped(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    created = await upload_problem(api_client, headers, org, slug="same")
    url = f"/v1/organizations/{org}/problems/same/revisions"

    same = await api_client.post(url, content=package_bytes(), headers={**headers, **ZIP})
    other_bytes = await api_client.post(url, content=rezipped(package_bytes()), headers={**headers, **ZIP})

    for response in (same, other_bytes):
        assert response.status_code == 200, response.text
        assert response.json()["created"] is False
        assert response.json()["revision"]["id"] == created["revision_id"]
    assert await count(db_session, BindingCaseRevision) == 1
    assert await count(db_session, Blob) == 1


async def test_another_package_is_the_next_revision(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    await upload_problem(api_client, headers, org, slug="grows")
    other = package_bytes(EXAMPLE.parent / "03_xor_choice")

    response = await api_client.post(
        f"/v1/organizations/{org}/problems/grows/revisions", content=other, headers={**headers, **ZIP},
    )

    assert response.status_code == 201, response.text
    assert response.json()["revision"]["revision"] == 2
    listed = await api_client.get(f"/v1/organizations/{org}/problems/grows/revisions", headers=headers)
    assert [item["revision"] for item in listed.json()] == [1, 2]
    by_digest = await api_client.get(
        f"/v1/organizations/{org}/problems/grows/revisions/{response.json()['revision']['package_digest']}",
        headers=headers,
    )
    assert by_digest.status_code == 200 and by_digest.json()["revision"] == 2


async def test_a_refused_package_answers_the_located_diagnostics_and_stores_nothing(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    broken = io.BytesIO()
    with zipfile.ZipFile(broken, "w") as archive:
        archive.writestr("instance.json", b'{"apiVersion": "bim/v1", "kind": "Instance", "metadata": {"name": "x"}, "spec": {}}')

    response = await api_client.post(
        f"/v1/organizations/{org}/problems", content=broken.getvalue(), headers={**headers, **ZIP},
    )

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "invalid_instance"
    assert response.json()["diagnostics"]
    assert await count(db_session, BindingCase) == 0
    assert await count(db_session, Blob) == 0


async def test_a_body_that_is_not_a_package_is_a_415(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)

    response = await api_client.post(f"/v1/organizations/{org}/problems", json={"snapshot": "x"}, headers=headers)

    assert response.status_code == 415, response.text


async def test_the_quotas_count_problems_and_the_size_of_the_callers_revisions(
    api_client, registration, db_session, gate, monkeypatch  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    await upload_problem(api_client, headers, org, slug="one")
    real = gate.caps
    limits: dict[str, float] = {}

    async def caps(user_id):
        base = await real(user_id)
        return PlanCaps(plan=base.plan, features=base.features, limits={**base.limits, **limits})

    monkeypatch.setattr(gate, "caps", caps)
    limits["maxProblems"] = 1
    refused = await api_client.post(
        f"/v1/organizations/{org}/problems", params={"slug": "two"}, content=package_bytes(), headers={**headers, **ZIP},
    )
    assert refused.status_code == 402, refused.text
    assert refused.json()["detail"]["quota"]["limit_id"] == "maxProblems"

    del limits["maxProblems"]
    size = int(await db_session.scalar(select(func.sum(BindingCaseRevision.package_size))))
    limits["maxRepositoryStorage"] = size / 10**6
    storage = await api_client.post(
        f"/v1/organizations/{org}/problems/one/revisions",
        content=package_bytes(EXAMPLE.parent / "03_xor_choice"), headers={**headers, **ZIP},
    )
    assert storage.status_code == 402, storage.text
    assert storage.json()["detail"]["quota"]["limit_id"] == "maxRepositoryStorage"
    assert storage.json()["detail"]["quota"]["used_bytes"] == size
    assert await count(db_session, BindingCaseRevision) == 1


async def test_a_viewer_reads_a_member_writes_and_an_admin_deletes(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    member, member_headers = await make_account(api_client, registration, db_session, gate)
    await put_member(api_client, headers, org, viewer["id"], "VIEWER")
    await put_member(api_client, headers, org, member["id"], "MEMBER")
    await upload_problem(api_client, headers, org, slug="shared")
    base = f"/v1/organizations/{org}/problems"

    assert (await api_client.get(base, headers=viewer_headers)).json()["total"] == 1
    assert (await api_client.get(f"{base}/shared", headers=viewer_headers)).status_code == 200
    refused = await api_client.post(base, params={"slug": "v"}, content=package_bytes(), headers={**viewer_headers, **ZIP})
    assert refused.status_code == 403, refused.text
    allowed = await api_client.post(base, params={"slug": "m"}, content=package_bytes(), headers={**member_headers, **ZIP})
    assert allowed.status_code == 201, allowed.text
    assert (await api_client.delete(f"{base}/m", headers=member_headers)).status_code == 403
    assert (await api_client.delete(f"{base}/m", headers=headers)).status_code == 204
    outsider, outsider_headers = await make_account(api_client, registration, db_session, gate)
    assert (await api_client.get(base, headers=outsider_headers)).status_code == 403


async def test_a_problem_a_run_names_is_kept(api_client, registration, db_session, gate):  # noqa: F811
    account, headers, org = await owner(api_client, registration, db_session, gate)
    created = await upload_problem(api_client, headers, org, slug="ran")
    revision_id = uuid.UUID(created["revision_id"])
    compilation = await db_session.scalar(select(ProblemCompilation).where(ProblemCompilation.revision_id == revision_id))
    problem = await db_session.get(BindingCase, uuid.UUID(created["problem"]["id"]))
    db_session.add(Job(
        created_by_id=uuid.UUID(account["id"]), engine_id="random-search", engine_job_id="e", service_url="http://engine",
        state=JobState.COMPLETED, revision_id=revision_id, compilation_id=compilation.id,
        organization_id=problem.organization_id,
    ))
    await db_session.flush()

    response = await api_client.delete(f"/v1/organizations/{org}/problems/ran", headers=headers)

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "problem_has_runs"
    assert await count(db_session, BindingCaseRevision) == 1


async def test_deleting_a_problem_leaves_its_blob(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    await upload_problem(api_client, headers, org, slug="gone")

    assert (await api_client.delete(f"/v1/organizations/{org}/problems/gone", headers=headers)).status_code == 204

    assert (await count(db_session, BindingCase), await count(db_session, BindingCaseRevision)) == (0, 0)
    assert await count(db_session, ProblemCompilation) == 0
    assert await count(db_session, Blob) == 1


async def test_the_source_is_the_uploaded_package_with_its_digests(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    archive = rezipped(package_bytes())
    created = await upload_problem(api_client, headers, org, slug="src", archive=archive)

    response = await api_client.get(f"/v1/organizations/{org}/problems/src/revisions/1/source", headers=headers)

    assert response.status_code == 200
    assert response.content == archive
    assert response.headers["etag"] == f'"{created["revision"]["package_digest"]}"'
    assert response.headers["digest"] == "sha-256=" + digest_bytes(archive).removeprefix("sha256-")
    assert created["revision"]["package_digest"] != digest_bytes(archive)


async def test_a_revision_describes_its_files_and_compilations(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    await upload_problem(api_client, headers, org, slug="facts")
    base = f"/v1/organizations/{org}/problems/facts/revisions/1"

    detail = (await api_client.get(base, headers=headers)).json()
    compilation = (await api_client.get(f"{base}/compilation", headers=headers)).json()
    ir = await api_client.get(f"{base}/compilations/{compilation['id']}/ir", headers=headers)

    assert detail["document"]["kind"] == "Instance"
    assert {item["path"] for item in detail["files"]} >= {"instance.json"}
    assert all(set(item) == {"path", "role", "resource_id", "digest", "media_type"} for item in detail["files"])
    assert [item["current"] for item in detail["compilations"]] == [True]
    assert compilation["analysis"]["tasks"] >= 1
    assert all(entry["kind"] for entry in compilation["resources"].values())
    assert compilation["compatible_modes"]
    assert ir.status_code == 200 and ir.json()["ir"]["kind"] == "BindingProblem"
    assert ir.json()["ir_digest"] == compilation["ir_digest"]
    assert compilation["semantic_digest"] == semantic_digest(ir.json()["ir"])
    assert [item["semantic_digest"] for item in detail["compilations"]] == [compilation["semantic_digest"]]


async def test_an_edit_needs_the_current_etag(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    await upload_problem(api_client, headers, org, slug="tagged")
    url = f"/v1/organizations/{org}/problems/tagged"
    etag = (await api_client.get(url, headers=headers)).headers["etag"]

    edited = await api_client.patch(url, json={"name": "Renamed"}, headers={**headers, "If-Match": etag})
    stale = await api_client.patch(url, json={"name": "Again"}, headers={**headers, "If-Match": etag})

    assert edited.status_code == 200 and edited.json()["name"] == "Renamed"
    assert edited.headers["etag"] != etag
    assert stale.status_code == 412, stale.text


async def test_the_list_searches_and_pages(api_client, registration, db_session, gate):  # noqa: F811
    account, headers, org = await owner(api_client, registration, db_session, gate)
    await upload_problem(api_client, headers, org, slug="alpha")
    await upload_problem(api_client, headers, org, slug="beta", path=EXAMPLE.parent / "03_xor_choice")

    found = (await api_client.get(f"/v1/organizations/{org}/problems", params={"q": "alp"}, headers=headers)).json()
    paged = (await api_client.get(f"/v1/organizations/{org}/problems", params={"limit": 1}, headers=headers)).json()

    assert [item["slug"] for item in found["problems"]] == ["alpha"]
    assert found["problems"][0]["latest_revision"]["current_compilation"]["binding_space"]
    assert (paged["total"], len(paged["problems"])) == (2, 1)


async def test_seeded_runs_reference_their_problem(db_session):
    user = User(username=f"u{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@example.org", password_hash="x", plan_cache="FREE")
    db_session.add(user)
    await db_session.flush()

    seeded = await seed_problem_run(db_session, created_by_id=user.id)

    assert (await db_session.get(BindingCaseRevision, seeded["revision_id"])).binding_case_id == seeded["problem_id"]


# -- Filtering by the composition that links a problem (F2b B3) -------------------------------------------


async def test_the_list_filters_on_the_composition_that_links_a_problem(
    api_client, registration, db_session, gate  # noqa: F811
):
    from _b3_links import an_organization_with_links

    world = await an_organization_with_links(api_client, registration, db_session, gate)
    url = f"/v1/organizations/{world.org}/problems"

    async def listed(**params):
        response = await api_client.get(url, params=params, headers=world.headers)
        assert response.status_code == 200, response.text
        return response.json()

    every = await listed()
    assert sorted(row["slug"] for row in every["problems"]) == sorted([world.linked.slug, world.other.slug])
    assert {row["latest_revision"]["origin"] for row in every["problems"]} == {"upload"}
    for ref in ("shop", world.shop["id"]):
        found = await listed(composition=ref)
        assert [row["slug"] for row in found["problems"]] == [world.linked.slug] and found["total"] == 1
    assert (await listed(composition="plain")) == {"problems": [], "total": 0, "limit": 50, "offset": 0}
    for unknown in ("nowhere", str(uuid.uuid4())):
        assert (await listed(composition=unknown)) == {"problems": [], "total": 0, "limit": 50, "offset": 0}
    assert (await listed(composition="shop", origin="editor"))["problems"] == []


async def test_the_composition_filter_reads_only_the_callers_organization(
    api_client, registration, db_session, gate  # noqa: F811
):
    from _b3_links import an_organization_with_links

    world = await an_organization_with_links(api_client, registration, db_session, gate)
    elsewhere = await make_org(api_client, world.headers)
    await upload_problem(api_client, world.headers, elsewhere)

    response = await api_client.get(
        f"/v1/organizations/{elsewhere}/problems", params={"composition": world.shop["id"]}, headers=world.headers,
    )

    assert response.status_code == 200 and response.json()["problems"] == []
