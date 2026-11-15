"""Compile-or-get (D6): one compilation per revision and toolchain, insert only, tied to its revision."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from _problem_helpers import problem_for, seed_problem_run
from openbinding_gateway.db.models import Job, JobState, ProblemCompilation, User
from openbinding_gateway.integrations import bim
from openbinding_gateway.modules.problems.application import compilation_by_digest, compile_or_get, semantic_digest

pytestmark = pytest.mark.asyncio

OTHER_COMPILER = "sha256-" + "e" * 64
#: ``semanticDigest`` of ``examples/demo/01_simple_seq`` in the bim-toolchain v0.2.0 corpus golden
#: (``golden/bim_normalized/corpus.json``), written out so that this module needs no kit.
SIMPLE_SEQ_SEMANTIC = "sha256-ffc9ca032d7e3afbe7a0e94ab574a60324e94c0376ac3284bdf70bbb00ca5cc1"


class OtherToolchain:
    """The installed toolchain, reporting another ``compilerDigest`` in its capabilities and its compile results."""

    def __init__(self, inner) -> None:
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def capabilities(self):
        return {**self._inner.capabilities(), "compilerDigest": OTHER_COMPILER}

    def compile(self, archive, registered=()):
        result = dict(self._inner.compile(archive, registered))
        result["toolchain"] = {**dict(result.get("toolchain") or {}), "compilerDigest": OTHER_COMPILER}
        result["compilationDigest"] = "sha256-" + "d" * 64
        return result


async def a_user(db) -> User:
    user = User(
        username=f"u{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="x", plan_cache="FREE",
    )
    db.add(user)
    await db.commit()
    return user


async def compilations(db, revision_id) -> list[ProblemCompilation]:
    return list((await db.scalars(
        select(ProblemCompilation).where(ProblemCompilation.revision_id == revision_id).order_by(ProblemCompilation.created_at)
    )).all())


async def test_compiling_twice_gives_one_row(db_session):
    upload = await problem_for(db_session, await a_user(db_session))

    first = await compile_or_get(db_session, upload.revision)
    second = await compile_or_get(db_session, upload.revision)

    assert first.id == second.id == upload.compilation.id
    assert len(await compilations(db_session, upload.revision.id)) == 1


async def test_another_toolchain_adds_a_row_and_leaves_the_first(db_session):
    upload = await problem_for(db_session, await a_user(db_session))
    before = upload.compilation

    with bim.bim_override(OtherToolchain(bim.get_bim())):
        added = await compile_or_get(db_session, upload.revision)
        again = await compile_or_get(db_session, upload.revision)

    rows = await compilations(db_session, upload.revision.id)
    assert added.id == again.id != before.id
    assert added.compiler_digest == OTHER_COMPILER
    assert [row.id for row in rows] == [before.id, added.id]
    assert (await db_session.get(ProblemCompilation, before.id)).compilation_digest == before.compilation_digest


async def test_a_compilation_stores_the_semantic_digest_of_its_ir(db_session):
    upload = await problem_for(db_session, await a_user(db_session))

    row = await db_session.get(ProblemCompilation, upload.compilation.id)

    assert row.semantic_digest == semantic_digest(row.ir) == SIMPLE_SEQ_SEMANTIC


async def test_another_toolchain_that_reads_the_problem_alike_gives_the_same_semantic_digest(db_session):
    upload = await problem_for(db_session, await a_user(db_session))
    before = upload.compilation

    with bim.bim_override(OtherToolchain(bim.get_bim())):
        added = await compile_or_get(db_session, upload.revision)

    assert added.compiler_digest != before.compiler_digest
    assert added.compilation_digest != before.compilation_digest
    assert added.semantic_digest == before.semantic_digest == SIMPLE_SEQ_SEMANTIC


async def test_a_compilation_is_found_by_its_digest_within_its_revision(db_session):
    user = await a_user(db_session)
    upload = await problem_for(db_session, user)
    before = upload.compilation
    with bim.bim_override(OtherToolchain(bim.get_bim())):
        added = await compile_or_get(db_session, upload.revision)
    other = await seed_problem_run(db_session, created_by_id=user.id)

    assert (await compilation_by_digest(db_session, upload.revision.id, before.compilation_digest)).id == before.id
    assert (await compilation_by_digest(db_session, upload.revision.id, added.compilation_digest)).id == added.id
    assert await compilation_by_digest(db_session, other["revision_id"], before.compilation_digest) is None
    other_digest = (await db_session.get(ProblemCompilation, other["compilation_id"])).compilation_digest
    assert await compilation_by_digest(db_session, upload.revision.id, other_digest) is None


async def test_a_compilation_cannot_be_updated(db_session):
    upload = await problem_for(db_session, await a_user(db_session))

    with pytest.raises(IntegrityError, match="sealed and immutable"):
        await db_session.execute(
            update(ProblemCompilation).where(ProblemCompilation.id == upload.compilation.id).values(ir_digest="sha256-x")
        )


async def test_a_revision_cannot_be_updated(db_session):
    from openbinding_gateway.db.models import BindingCaseRevision

    upload = await problem_for(db_session, await a_user(db_session))

    with pytest.raises(IntegrityError, match="sealed and immutable"):
        await db_session.execute(
            update(BindingCaseRevision).where(BindingCaseRevision.id == upload.revision.id).values(package_size=1)
        )


async def test_a_run_whose_compilation_belongs_to_another_revision_is_refused(db_session):
    user = await a_user(db_session)
    one = await seed_problem_run(db_session, created_by_id=user.id)
    other = await seed_problem_run(db_session, created_by_id=user.id, organization_id=one["organization_id"])
    await db_session.commit()
    # SQLite checks foreign keys only when asked to, outside a transaction (PostgreSQL always does).
    async with db_session.bind.connect() as connection:
        autocommit = await connection.execution_options(isolation_level="AUTOCOMMIT")
        await autocommit.exec_driver_sql("PRAGMA foreign_keys=ON")

    db_session.add(Job(
        created_by_id=user.id, engine_id="random-search", engine_job_id="e", service_url="http://engine",
        state=JobState.QUEUED, organization_id=one["organization_id"],
        revision_id=one["revision_id"], compilation_id=other["compilation_id"],
    ))
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()
    assert await db_session.scalar(select(func.count()).select_from(Job)) == 0
