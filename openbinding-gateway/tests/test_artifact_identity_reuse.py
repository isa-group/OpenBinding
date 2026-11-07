"""An archived artifact frees its identity, and that is a property of the index.

``uq_artifact_identity`` was a plain unique constraint over ``(namespace, name)``. It is now
a unique index partial on ``archived``, so retiring an artifact releases the name people
cite instead of keeping it taken for ever. SPHERE reaches the same end on its pricing
identities with ``partialFilterExpression: {deleted: false}``, and the reason is the same:
a withdrawal should not be permanent in a way nobody asked for.

Phase F2 needs it because a composition is an artifact, and a composition that is retired
and re-created under the same name is an ordinary thing to want -- as is forking into a name
whose previous holder was archived.

This runs on SQLite, where the test schema comes from ``Base.metadata.create_all``, so it
pins what the **model** declares. ``test_artifact_identity_reuse_pg.py`` pins the same
property on a PostgreSQL database built by the **migrations**, because the predicate is
spelled per dialect (``archived = 0`` against ``archived = false``) and only one of the two
can be wrong at a time.
"""
import pytest
from sqlalchemy.exc import IntegrityError

from openbinding_gateway.db.models import Artifact, Organization, User


async def _owner(session) -> tuple[User, Organization]:
    user = User(username='identity-owner', email='identity-owner@example.org',
                password_hash='unused', plan_cache='RESEARCH')
    session.add(user)
    await session.flush()
    org = Organization(slug='identity-team', name='Identity team',
                       billing_sponsor_user_id=user.id, created_by_id=user.id)
    session.add(org)
    await session.flush()
    return user, org


def _artifact(org: Organization, user: User, name: str, *, archived: bool) -> Artifact:
    return Artifact(organization_id=org.id, namespace=str(org.id), name=name,
                    display_name=name, kind='Composition', archived=archived,
                    created_by_id=user.id)


@pytest.mark.asyncio
async def test_two_live_artifacts_cannot_share_an_identity(db_session) -> None:
    """The half of the old constraint that has to survive the change."""
    user, org = await _owner(db_session)
    db_session.add(_artifact(org, user, 'fleet', archived=False))
    await db_session.flush()
    db_session.add(_artifact(org, user, 'fleet', archived=False))
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_an_archived_artifact_may_keep_the_name_of_a_live_one(db_session) -> None:
    """The index covers the live rows, so the archived one is outside it."""
    user, org = await _owner(db_session)
    db_session.add(_artifact(org, user, 'fleet', archived=False))
    db_session.add(_artifact(org, user, 'fleet', archived=True))
    await db_session.flush()


@pytest.mark.asyncio
async def test_archiving_frees_the_identity_for_a_new_artifact(db_session) -> None:
    """The case the change exists for: retire a composition, create another under its name."""
    user, org = await _owner(db_session)
    retired = _artifact(org, user, 'fleet', archived=False)
    db_session.add(retired)
    await db_session.flush()

    retired.archived = True
    await db_session.flush()

    successor = _artifact(org, user, 'fleet', archived=False)
    db_session.add(successor)
    await db_session.flush()
    assert successor.id != retired.id, "a second artifact, not the same one reused"


@pytest.mark.asyncio
async def test_a_version_may_be_based_on_a_version_of_another_artifact(db_session) -> None:
    """What makes a fork expressible at all, and it needs no new column.

    ``ArtifactVersion.based_on_id`` is a foreign key to ``artifact_versions.id`` with no
    same-artifact restriction, so a fork is a new artifact whose first version points at the
    origin's. It is ``ondelete='RESTRICT'``, so the lineage cannot be broken by deleting the
    origin -- a stronger guarantee than SPHERE's denormalised ``forkedFrom`` record, which
    exists there because its origin can disappear.
    """
    column = Artifact.__table__.metadata.tables['artifact_versions'].c.based_on_id
    targets = {key.column.table.name for key in column.foreign_keys}
    assert targets == {'artifact_versions'}
    assert all(key.ondelete == 'RESTRICT' for key in column.foreign_keys)
    assert any(index.name == 'ix_artifact_versions_based_on_id'
               for index in Artifact.__table__.metadata.tables['artifact_versions'].indexes), (
        "the re-fork query reads this edge backwards, so it is indexed"
    )
