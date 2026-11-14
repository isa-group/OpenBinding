"""A stray hard delete of an account fails loudly on PostgreSQL instead of destroying shared history.

Deleting an account pseudonymises its row (``routes/users.py``), so nothing in the gateway
deletes a user. The foreign keys that history holds on the account are RESTRICT
(``jobs.owner_id``, ``v1_engine_revisions``, ``v1_engine_registration_revisions``,
``v1_manifest_publications``), while what belongs to the account alone (API keys, refresh
tokens, memberships, notifications) still goes with it. SQLite enforces no foreign keys in the
suite, so this is the only check of the RESTRICT.

Needs ``TEST_DATABASE_URL`` (the ``pg`` fixture skips without it); synthetic data, no network.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from openbinding_gateway.db.models import (
    ApiKey,
    EngineRegistrationRevision,
    EngineRevision,
    Job,
    JobState,
    ManifestPublication,
    Notification,
    User,
)


async def a_user(session) -> User:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.com", password_hash="x", plan_cache="FREE")
    session.add(user)
    await session.flush()
    return user


def digest() -> str:
    return "sha256-" + uuid.uuid4().hex * 2


def history_of(user: User) -> dict[str, object]:
    engine_digest = digest()
    return {
        "job": Job(
            owner_id=user.id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="http://engine",
            state=JobState.COMPLETED, original_request={}, options={}, provenance={},
        ),
        "engine": EngineRevision(
            owner_id=user.id, namespace=user.username, name="solver", version="1.0.0", digest=engine_digest, document={},
        ),
        "registration": EngineRegistrationRevision(
            owner_id=user.id, namespace=user.username, name="solver-eu", version="1.0.0", manifest_digest=digest(),
            engine_digest=engine_digest, document={}, endpoint="https://solver.example.org",
            protocol_digest="sha256-" + "0" * 64, mappings={},
        ),
        "publication": ManifestPublication(
            resource_kind="Engine", resource_digest=engine_digest, publisher_id=user.id, state="published",
        ),
    }


@pytest.mark.parametrize("kind", ["job", "engine", "registration", "publication"])
async def test_a_user_that_history_names_cannot_be_hard_deleted(pg, kind) -> None:
    async with pg.session() as session:
        user = await a_user(session)
        session.add(history_of(user)[kind])
        await session.commit()
        user_id = user.id

    async with pg.session() as session:
        with pytest.raises(IntegrityError, match="violates foreign key constraint"):
            await session.execute(delete(User).where(User.id == user_id))
        await session.rollback()
        assert await session.get(User, user_id) is not None


async def test_what_belongs_to_the_account_alone_still_goes_with_a_hard_delete(pg) -> None:
    async with pg.session() as session:
        user = await a_user(session)
        session.add_all([
            ApiKey(user_id=user.id, name="k", prefix=f"obk_{uuid.uuid4().hex[:8]}", secret_hash="0" * 64, grants={}),
            Notification(user_id=user.id, kind="test", subject="s", body="b"),
        ])
        await session.commit()
        user_id = user.id

    async with pg.session() as session:
        await session.execute(delete(User).where(User.id == user_id))
        await session.commit()
        for model, column in ((ApiKey, ApiKey.user_id), (Notification, Notification.user_id)):
            assert await session.scalar(select(func.count()).select_from(model).where(column == user_id)) == 0
