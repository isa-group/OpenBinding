"""Problems for the tests: upload one through the API, or seed one (and a run of it) in the database.

Not a test module (no ``test_`` prefix). A run names a problem revision and its compilation, and belongs to
the problem's organization (``jobs.revision_id``, ``compilation_id`` and ``organization_id`` are NOT NULL),
so every test that writes a ``Job`` row gets its references from ``seed_problem_run``; every test that runs
one through ``createRun`` gets a revision (and its organization) from ``upload_problem``. ``runs_url`` and
``run_url`` build the addresses of the runs API.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from bim_core.canonical import digest
from bim_core.package import load_package

from _repo import REPO_ROOT

ZIP = {"Content-Type": "application/vnd.bim+zip"}
EXAMPLE = REPO_ROOT / "examples" / "demo" / "01_simple_seq"


def package_bytes(path: Path = EXAMPLE) -> bytes:
    """A package directory as a ``.bim.zip``."""
    return load_package(path).to_zip()


async def make_org(client, headers, slug: str | None = None) -> str:
    """A new organization of the caller (OWNER); returns its slug."""
    slug = slug or f"org-{uuid.uuid4().hex[:10]}"
    response = await client.post("/v1/organizations", json={"slug": slug, "name": slug}, headers=headers)
    assert response.status_code == 201, response.text
    return slug


#: The organization of every revision ``upload_problem`` made, so a test holding only the revision id can
#: address the runs of its organization (``runs_url_for``).
_REVISION_ORGS: dict[str, str] = {}


async def upload_problem(
    client,
    headers: dict[str, str],
    org: str | None = None,
    *,
    archive: bytes | None = None,
    path: Path = EXAMPLE,
    slug: str | None = None,
) -> dict[str, Any]:
    """Upload a package as a new problem (in a new organization unless ``org`` names one).

    Returns ``{"org", "problem", "revision", "revision_id", "compilation"}`` (the problem, revision and
    compilation as the API answered them).
    """
    org = org or await make_org(client, headers)
    params = {"slug": slug or f"p-{uuid.uuid4().hex[:10]}"}
    response = await client.post(
        f"/v1/organizations/{org}/problems",
        params=params,
        content=archive if archive is not None else package_bytes(path),
        headers={**headers, **ZIP},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    _REVISION_ORGS[body["revision"]["id"]] = org
    return {
        "org": org,
        "problem": body["problem"],
        "revision": body["revision"],
        "revision_id": body["revision"]["id"],
        "compilation": body["compilation"],
    }


def runs_url(org: Any) -> str:
    """The runs of an organization (a slug, an id, or anything with an ``organization_id``)."""
    reference = getattr(org, "organization_id", org)
    return f"/v1/organizations/{reference}/runs"


def run_url(job: Any, suffix: str = "", *, org: Any = None) -> str:
    """One run's address (``suffix`` like ``"/cancel"``): a ``Job`` row names its organization; else pass ``org``."""
    run_id = getattr(job, "id", job)
    return f"{runs_url(org if org is not None else job)}/{run_id}{suffix}"


def runs_url_for(revision_id: Any) -> str:
    """The runs of the organization of a revision ``upload_problem`` made in this process."""
    return runs_url(_REVISION_ORGS[str(revision_id)])


async def revision_of(client, headers, org: str | None = None, **kwargs) -> str:
    """The id of a freshly uploaded revision (in a new organization unless ``org`` names one)."""
    return (await upload_problem(client, headers, org, **kwargs))["revision_id"]


MINIMAL_IR: dict[str, Any] = {"apiVersion": "bim/v1", "kind": "BindingProblem", "spec": {}}


async def seed_problem_run(
    db,
    *,
    created_by_id: uuid.UUID,
    organization_id: uuid.UUID | None = None,
    ir: dict[str, Any] | None = None,
    ir_digest: str | None = None,
) -> dict[str, Any]:
    """Seed a problem with one revision and one compilation, without an upload; return a run's references.

    The rows are written directly (the blob points at no file), so this suits tests that build ``Job`` rows by
    hand. ``ir`` defaults to a minimal BindingProblem; its digest is ``ir_digest`` or ``digest(ir)``. The
    result has ``organization_id``, ``revision_id`` and ``compilation_id`` (spread them into ``Job(...)``) and
    ``ir_digest``, ``ir``, ``problem_id`` and ``package_digest``.
    """
    from openbinding_gateway.db.models import (
        BindingCase,
        BindingCaseRevision,
        Blob,
        Organization,
        ProblemCompilation,
    )
    from openbinding_gateway.modules.problems.application import semantic_digest

    if organization_id is None:
        organization = Organization(slug=f"org-{uuid.uuid4().hex[:10]}", name="Seeded", created_by_id=created_by_id)
        db.add(organization)
        await db.flush()
        organization_id = organization.id
    ir = ir if ir is not None else dict(MINIMAL_IR)
    ir_digest = ir_digest or digest(ir)
    package_digest = "sha256-" + uuid.uuid4().hex + uuid.uuid4().hex
    blob = Blob(
        organization_id=organization_id, digest="sha256-" + uuid.uuid4().hex + uuid.uuid4().hex,
        media_type="application/vnd.bim+zip", size_bytes=1,
        storage_uri=f"/nonexistent/{uuid.uuid4().hex}", created_by_id=created_by_id,
    )
    problem = BindingCase(
        organization_id=organization_id, slug=f"p-{uuid.uuid4().hex[:10]}", name="Seeded problem",
        created_by_id=created_by_id,
    )
    db.add_all([blob, problem])
    await db.flush()
    revision = BindingCaseRevision(
        binding_case_id=problem.id, revision=1, package_digest=package_digest, package_blob_id=blob.id,
        package_size=1, document={"apiVersion": "bim/v1", "kind": "Instance", "metadata": {"name": "seeded"}},
        files=[], resource_digests={}, created_by_id=created_by_id,
    )
    db.add(revision)
    await db.flush()
    compilation = ProblemCompilation(
        revision_id=revision.id, compiler_digest="sha256-" + "c" * 64,
        compilation_digest="sha256-" + uuid.uuid4().hex + uuid.uuid4().hex,
        semantic_digest=semantic_digest(ir), toolchain={}, ir_digest=ir_digest, ir=ir, source_map={}, analysis={},
    )
    db.add(compilation)
    await db.flush()
    return {
        "organization_id": organization_id,
        "revision_id": revision.id,
        "compilation_id": compilation.id,
        "problem_id": problem.id,
        "package_digest": package_digest,
        "ir_digest": ir_digest,
        "ir": ir,
    }


def run_refs(seeded: dict[str, Any]) -> dict[str, Any]:
    """The three columns a ``Job`` row needs, out of ``seed_problem_run``'s result."""
    return {key: seeded[key] for key in ("organization_id", "revision_id", "compilation_id")}


async def problem_for(db, user, *, organization=None, path: Path = EXAMPLE, slug: str | None = None):
    """Upload a package as a problem of ``organization`` (a new one, ``user`` its OWNER, by default) without HTTP.

    Returns the ``modules.problems`` ``Upload``: ``.problem``, ``.revision`` and ``.compilation``.
    """
    from openbinding_gateway.db.models import Organization, OrganizationMembership, OrganizationRole
    from openbinding_gateway.modules.problems.application import create_problem

    if organization is None:
        organization = Organization(slug=f"org-{uuid.uuid4().hex[:10]}", name="Problems", created_by_id=user.id)
        db.add(organization)
        await db.flush()
        db.add(OrganizationMembership(organization_id=organization.id, user_id=user.id, role=OrganizationRole.OWNER))
        await db.flush()
    return await create_problem(
        db, organization, package_bytes(path), user, slug=slug or f"p-{uuid.uuid4().hex[:10]}",
    )


def placeholder_refs(*skip: str) -> dict[str, uuid.UUID]:
    """Random references for a ``Job`` row of a SQLite test that never reads them (SQLite checks no foreign key).

    ``skip`` names the ones the caller passes itself (``"organization_id"``, say).
    """
    refs = {"organization_id": uuid.uuid4(), "revision_id": uuid.uuid4(), "compilation_id": uuid.uuid4()}
    return {key: value for key, value in refs.items() if key not in skip}


async def compiled_run_refs(db, owner_id: uuid.UUID) -> dict[str, uuid.UUID]:
    """The references of a run of a real, compiled problem of ``owner_id`` (OWNER of its new organization).

    For tests that retry, re-evaluate or run a ``Job`` row they build by hand: those read the compilation.
    """
    from openbinding_gateway.db.models import User

    upload = await problem_for(db, await db.get(User, owner_id))
    return {
        "organization_id": upload.problem.organization_id,
        "revision_id": upload.revision.id,
        "compilation_id": upload.compilation.id,
    }


async def seeded_run_refs(db, owner_id: uuid.UUID | None = None) -> dict[str, uuid.UUID]:
    """``run_refs(seed_problem_run(...))``, with a throwaway owner for a test whose job has none."""
    if owner_id is None:
        from openbinding_gateway.db.models import User

        user = User(
            username=f"seed{uuid.uuid4().hex[:8]}", email=f"seed{uuid.uuid4().hex[:8]}@example.org",
            password_hash="x", plan_cache="FREE",
        )
        db.add(user)
        await db.flush()
        owner_id = user.id
    return run_refs(await seed_problem_run(db, created_by_id=owner_id))
