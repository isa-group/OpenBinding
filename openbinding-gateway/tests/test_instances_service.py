"""The instances service, called directly: no HTTP, no router.

``tests/test_v1_persistence.py`` and ``tests/test_v1_package_security.py`` cover the same rules through
``/v1/instances`` and ``/v1/validate``; these pin the service's own contract: what it raises, what it returns,
and the properties that must hold whoever calls it. Above all, a snapshot belongs to the account that made it:
the same package uploaded by two accounts is two snapshots, and neither account can read the other's.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from bim_core import PackageError
from bim_core.package import load_package
from fastapi import HTTPException
from sqlalchemy import func, select

from _pricing import pricing_catalog
from _repo import REPO_ROOT

from openbinding_gateway.db.models import BindingIRSnapshot, InstanceSnapshot, User, UserRole
from openbinding_gateway.services import instances
from openbinding_gateway.services.instances import InstanceProblem, PackageRequest
from openbinding_gateway.services.snapshots import persist_snapshot

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
ZIP = "application/vnd.bim+zip"
BIG = 10_000_000


def upload(
    body: bytes,
    *,
    content_type: str = ZIP,
    max_compressed: int = BIG,
    max_expanded: int = BIG,
    **headers: str,
) -> PackageRequest:
    async def read_body() -> bytes:
        return body

    return PackageRequest(
        {"content-type": content_type, **headers}, read_body, lambda: max_compressed, lambda: max_expanded
    )


ARCHIVE = load_package(EXAMPLE).to_zip()


def package() -> bytes:
    """The very same bytes every time, so that what is stored can be compared with what was uploaded."""
    return ARCHIVE


async def make_user(session) -> User:
    account = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    session.add(account)
    await session.commit()
    return account


@pytest_asyncio.fixture
async def alice(db_session) -> User:
    return await make_user(db_session)


@pytest_asyncio.fixture
async def bob(db_session) -> User:
    return await make_user(db_session)


async def create(session, caller, archive: bytes | None = None) -> dict:
    created = await instances.create_snapshot(
        upload(archive or package()), caller, session, persist=persist_snapshot
    )
    await session.commit()
    return created


async def count(session, model) -> int:
    return (await session.execute(select(func.count()).select_from(model))).scalar_one()


async def refused(call) -> InstanceProblem:
    with pytest.raises(InstanceProblem) as raised:
        await call
    return raised.value


# -- Snapshots are deduplicated inside their owner, never across accounts ---------


async def test_a_snapshot_is_created_with_the_identities_of_its_package(db_session, alice):
    created = await create(db_session, alice)

    assert created["kind"] == "InstanceSnapshot"
    assert uuid.UUID(created["id"])
    assert set(created) == {
        "id", "kind", "instanceDigest", "packageDigest", "irDigest", "fileDigests", "resourceDigests",
    }
    stored = await db_session.get(InstanceSnapshot, uuid.UUID(created["id"]))
    assert stored.owner_id == alice.id
    assert stored.package_digest == created["packageDigest"]


async def test_the_same_package_uploaded_twice_by_its_owner_is_one_snapshot(db_session, alice):
    first = await create(db_session, alice)
    second = await create(db_session, alice)

    assert second["id"] == first["id"]
    assert await count(db_session, InstanceSnapshot) == 1
    assert await count(db_session, BindingIRSnapshot) == 1


async def test_the_same_package_uploaded_by_two_accounts_is_two_independent_snapshots(db_session, alice, bob):
    first = await create(db_session, alice)
    second = await create(db_session, bob)

    assert first["id"] != second["id"]
    # The package is the same, so its identities are: only the owner tells the snapshots apart.
    assert first["packageDigest"] == second["packageDigest"]
    assert first["instanceDigest"] == second["instanceDigest"]
    assert await count(db_session, InstanceSnapshot) == 2
    assert await count(db_session, BindingIRSnapshot) == 2
    owners = {
        row.id: row.owner_id for row in (await db_session.execute(select(InstanceSnapshot))).scalars()
    }
    assert owners == {uuid.UUID(first["id"]): alice.id, uuid.UUID(second["id"]): bob.id}

    # Uploading again changes nothing for either of them: no snapshot leaks from one account to the other.
    assert (await create(db_session, alice))["id"] == first["id"]
    assert (await create(db_session, bob))["id"] == second["id"]
    assert await count(db_session, InstanceSnapshot) == 2


async def test_without_a_database_there_is_no_snapshot(alice):
    problem = await refused(instances.create_snapshot(upload(package()), alice, None, persist=persist_snapshot))

    assert (problem.status, problem.code) == (503, "database_unavailable")


async def test_the_persister_is_the_one_the_caller_passes(db_session, alice):
    seen = []

    async def persist(compilation, caller, session):
        seen.append((compilation.package_digest, caller, session))
        return "the-id"

    created = await instances.create_snapshot(upload(package()), alice, db_session, persist=persist)

    assert created["id"] == "the-id"
    assert seen == [(created["packageDigest"], alice, db_session)]
    assert await count(db_session, InstanceSnapshot) == 0


# -- Who may read a snapshot -----------------------------------------------------


async def test_the_owner_reads_the_snapshot_back(db_session, alice):
    created = await create(db_session, alice)

    view = await instances.instance_view(created["id"], alice, db_session)
    assert view["id"] == created["id"]
    assert view["kind"] == "InstanceSnapshot"
    assert view["packageDigest"] == created["packageDigest"]
    assert view["irDigest"] == created["irDigest"]
    assert view["fileDigests"] == created["fileDigests"]
    assert view["resourceDigests"] == created["resourceDigests"]
    assert (await instances.instance_source(created["id"], alice, db_session)) == package()
    assert (await instances.instance_ir(created["id"], alice, db_session))["kind"] == "BindingProblem"

    detail = await instances.snapshot_detail(created["id"], alice, db_session)
    assert detail["ownerId"] == str(alice.id)
    assert detail["archiveSize"] == len(package())
    assert detail["ir"]["digest"] == created["irDigest"]

    archive = await instances.snapshot_archive(created["id"], alice, db_session)
    assert (archive.snapshot_id, archive.content, archive.package_digest) == (
        created["id"], package(), created["packageDigest"],
    )


async def test_another_account_cannot_read_the_snapshot_in_any_form(db_session, alice, bob):
    created = await create(db_session, alice)
    snapshot_id = created["id"]

    for read in (
        instances.instance_view,
        instances.instance_source,
        instances.instance_ir,
        instances.snapshot_detail,
        instances.snapshot_archive,
    ):
        problem = await refused(read(snapshot_id, bob, db_session))
        assert problem.status == 404, read.__name__
        assert problem.code == "not_found", read.__name__
        # What it says must not tell a snapshot that is not yours from one that does not exist.
        missing = await refused(read(str(uuid.uuid4()), bob, db_session))
        assert (missing.status, missing.code) == (problem.status, problem.code), read.__name__


async def test_a_caller_without_an_account_cannot_read_a_snapshot(db_session, alice):
    created = await create(db_session, alice)

    for read in (instances.instance_view, instances.instance_source, instances.instance_ir):
        assert (await refused(read(created["id"], None, db_session))).status == 404
    assert (await refused(instances.instance_view(created["id"], alice, None))).status == 404


async def test_a_reference_that_is_not_an_identifier_is_not_found(db_session, alice):
    problem = await refused(instances.instance_view("not-a-uuid", alice, db_session))

    assert (problem.status, problem.code, problem.detail) == (404, "not_found", "Snapshot not found")


async def test_the_snapshot_resources_need_a_database(alice):
    for read in (instances.snapshot_detail, instances.snapshot_archive):
        problem = await refused(read(str(uuid.uuid4()), alice, None))
        assert (problem.status, problem.code) == (503, "database_unavailable")


async def test_validating_a_snapshot_of_another_account_is_not_found(db_session, alice, bob):
    created = await create(db_session, alice)
    request = upload(f'{{"snapshot": "{created["id"]}"}}'.encode(), content_type="application/json")

    problem = await refused(instances.validate_package(request, bob, db_session))
    assert (problem.status, problem.code) == (404, "not_found")

    validated = await instances.validate_package(request, alice, db_session)
    assert validated["valid"] is True
    assert validated["packageDigest"] == created["packageDigest"]


# -- Limits ---------------------------------------------------------------------


async def test_an_upload_must_use_a_zip_media_type_before_any_limit_is_read():
    def limit() -> int:
        raise AssertionError("the limit is only read once the media type is accepted")

    request = PackageRequest({"content-type": "text/plain"}, upload(b"").read_body, limit, limit)

    with pytest.raises(HTTPException) as raised:
        await instances.read_package(request)
    assert raised.value.status_code == 415


async def test_an_upload_above_the_compressed_limit_is_a_413():
    with pytest.raises(HTTPException) as raised:
        await instances.read_package(upload(b"x" * 11, max_compressed=10))
    assert raised.value.status_code == 413

    assert await instances.read_package(upload(b"x" * 10, max_compressed=10)) == b"x" * 10


async def test_a_declared_length_above_the_limit_is_refused_before_the_body_is_read():
    async def never() -> bytes:
        raise AssertionError("the body must not be read")

    request = PackageRequest(
        {"content-type": ZIP, "content-length": "11"}, never, lambda: 10, lambda: BIG
    )

    with pytest.raises(HTTPException) as raised:
        await instances.read_package(request)
    assert raised.value.status_code == 413


async def test_the_limits_are_asked_for_when_they_apply_not_when_the_request_is_built(db_session, alice):
    limit = {"value": BIG}
    request = PackageRequest({"content-type": ZIP}, upload(package()).read_body, lambda: limit["value"], lambda: BIG)
    limit["value"] = 10

    with pytest.raises(HTTPException) as raised:
        await instances.create_snapshot(request, alice, db_session, persist=persist_snapshot)
    assert raised.value.status_code == 413
    assert await count(db_session, InstanceSnapshot) == 0


async def test_a_validation_request_above_the_expanded_limit_is_a_413(db_session, alice):
    request = upload(b'{"snapshot": "' + b"x" * 100 + b'"}', content_type="application/json", max_expanded=50)

    problem = await refused(instances.validate_package(request, alice, db_session))

    assert (problem.status, problem.code) == (413, "payload_too_large")


@pytest.mark.parametrize(
    "body",
    [b"[]", b'{"snapshot": ""}', b'{"snapshot": 3}', b'{"snapshot": "x", "extra": 1}', b"{}"],
)
async def test_a_validation_request_must_be_exactly_a_snapshot_reference(db_session, alice, body):
    problem = await refused(
        instances.validate_package(upload(body, content_type="application/json"), alice, db_session)
    )

    assert (problem.status, problem.code) == (422, "snapshot_or_package_required")


async def test_a_validation_body_that_is_not_json_is_an_invalid_request(db_session, alice):
    problem = await refused(
        instances.validate_package(upload(b"{not json", content_type="application/json"), alice, db_session)
    )

    assert (problem.status, problem.code) == (422, "invalid_request")
    assert "invalid JSON" in problem.detail


def test_a_multipart_upload_is_one_bounded_file_part():
    archive = package()
    boundary = "bim-boundary"

    def part(name: str) -> bytes:
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"package\"; filename=\"{name}\"\r\n"
            f"Content-Type: {ZIP}\r\n\r\n"
        ).encode() + archive + b"\r\n"

    content_type = f"multipart/form-data; boundary={boundary}"
    single = part("a.bim.zip") + f"--{boundary}--\r\n".encode()
    assert instances.multipart_zip(single, content_type, lambda: BIG) == archive
    with pytest.raises(PackageError, match="exceeds 10 bytes"):
        instances.multipart_zip(single, content_type, lambda: 10)
    with pytest.raises(PackageError, match="exactly one"):
        instances.multipart_zip(part("a") + part("b") + f"--{boundary}--\r\n".encode(), content_type, lambda: BIG)
    with pytest.raises(PackageError, match="invalid multipart Content-Type"):
        instances.multipart_zip(single, content_type + "\r\nX: y", lambda: BIG)


# -- A package the toolchain refuses is a controlled error -------------------------


async def test_a_corrupt_package_is_a_422_and_stores_nothing(db_session, alice):
    with pytest.raises(HTTPException) as raised:
        await instances.create_snapshot(
            upload(b"not a zip archive"), alice, db_session, persist=persist_snapshot
        )

    assert raised.value.status_code == 422
    assert "invalid ZIP archive" in str(raised.value.detail)
    assert await count(db_session, InstanceSnapshot) == 0
    assert await count(db_session, BindingIRSnapshot) == 0


async def test_a_corrupt_package_is_refused_by_every_way_of_validating_it(db_session, alice):
    for call in (
        instances.validate_legacy(upload(b"not a zip archive"), db_session),
        instances.validate_package(upload(b"not a zip archive"), alice, db_session),
    ):
        with pytest.raises(HTTPException) as raised:
            await call
        assert raised.value.status_code == 422
        assert "invalid ZIP archive" in str(raised.value.detail)


async def test_a_package_the_compiler_cannot_read_is_a_422_with_its_message(db_session):
    async def unreadable(archive, session, caller):
        raise PackageError("the toolchain refused this")

    with pytest.raises(HTTPException) as raised:
        await instances.compile_upload(b"anything", db_session, compiler=unreadable)

    assert (raised.value.status_code, raised.value.detail) == (422, "the toolchain refused this")


async def test_a_valid_upload_is_reported_with_the_identities_and_the_engines_that_fit(db_session, alice):
    created = await create(db_session, alice)

    validated = await instances.validate_package(upload(package()), alice, db_session)

    assert validated["valid"] is True
    assert validated["diagnostics"] == []
    assert validated["instanceDigest"] == created["instanceDigest"]
    assert validated["irDigest"] == created["irDigest"]
    assert validated["analysis"]["tasks"] > 0
    assert isinstance(validated["compatibleModes"], list)
    # Validating stores nothing.
    assert await count(db_session, InstanceSnapshot) == 1

    legacy = await instances.validate_legacy(upload(package()), db_session)
    assert legacy["packageDigest"] == created["packageDigest"]
    assert "analysis" not in legacy
