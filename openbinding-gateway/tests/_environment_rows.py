"""Rows for the composition-environment tests, written without HTTP (SQLite and PostgreSQL alike).

Not a test module (no ``test_`` prefix). ``world`` writes a user, an organization, a composition with two declared
versions (each with its declared evaluation) and, when asked, a second composition with one version, and returns
their ids; ``environment`` and ``adoption`` write the F4 rows on top.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass

from openbinding_gateway.db.models import (
    Composition,
    CompositionAdoption,
    CompositionEnvironment,
    CompositionEnvironmentKey,
    CompositionEvaluation,
    CompositionVersion,
    EvaluationBasis,
    EvaluationOutcome,
    Organization,
    User,
    ValuesStatus,
)


@dataclass(frozen=True)
class World:
    user_id: uuid.UUID
    organization_id: uuid.UUID
    composition_id: uuid.UUID
    versions: tuple[uuid.UUID, ...]
    evaluations: tuple[uuid.UUID, ...]
    other_composition_id: uuid.UUID
    other_version_id: uuid.UUID
    other_evaluation_id: uuid.UUID


async def _version(session, composition_id, user_id, ordinal: int, label: str) -> tuple[uuid.UUID, uuid.UUID]:
    content = f"syntaxVersion: \"1.0\"\ncomposition: c\nversion: {label}\n"
    digest = "sha256-" + hashlib.sha256(f"{composition_id}{label}".encode()).hexdigest()
    version = CompositionVersion(
        composition_id=composition_id, ordinal=ordinal, label=label, syntax_version="1.0",
        values_status=ValuesStatus.DECLARED, content=content, content_digest=digest,
        size_bytes=len(content.encode()), analytics={}, created_by_id=user_id,
    )
    session.add(version)
    await session.flush()
    evaluation = CompositionEvaluation(
        version_id=version.id, basis=EvaluationBasis.DECLARED, basis_key="declared",
        outcome=EvaluationOutcome.DECLARED, values={}, diagnostics=[], created_by_id=user_id,
    )
    session.add(evaluation)
    await session.flush()
    return version.id, evaluation.id


async def world(session) -> World:
    suffix = uuid.uuid4().hex[:8]
    user = User(username=f"u{suffix}", email=f"u{suffix}@example.org", password_hash="x", plan_cache="FREE")
    session.add(user)
    await session.flush()
    organization = Organization(slug=f"o-{suffix}", name="O", created_by_id=user.id)
    session.add(organization)
    await session.flush()
    composition = Composition(organization_id=organization.id, slug="shop", name="Shop", created_by_id=user.id)
    other = Composition(organization_id=organization.id, slug="other", name="Other", created_by_id=user.id)
    session.add_all([composition, other])
    await session.flush()
    v1, e1 = await _version(session, composition.id, user.id, 1, "1.0.0")
    v2, e2 = await _version(session, composition.id, user.id, 2, "1.1.0")
    ov, oe = await _version(session, other.id, user.id, 1, "1.0.0")
    await session.commit()
    return World(user.id, organization.id, composition.id, (v1, v2), (e1, e2), other.id, ov, oe)


async def environment(session, w: World, slug: str = "production", **values) -> uuid.UUID:
    row = CompositionEnvironment(
        organization_id=w.organization_id, composition_id=w.composition_id, slug=slug, name=slug.title(),
        created_by_id=w.user_id, **values,
    )
    session.add(row)
    await session.flush()
    return row.id


async def adoption(session, w: World, environment_id, ordinal: int, version_index: int = 0, **values) -> uuid.UUID:
    row = CompositionAdoption(
        environment_id=environment_id, ordinal=ordinal, composition_id=w.composition_id,
        version_id=w.versions[version_index], evaluation_id=w.evaluations[version_index],
        content_digest="sha256-" + "0" * 64, actor_id=w.user_id, **{"source": "direct", **values},
    )
    session.add(row)
    await session.flush()
    return row.id


async def key(session, w: World, environment_id, prefix: str | None = None) -> uuid.UUID:
    row = CompositionEnvironmentKey(
        environment_id=environment_id, prefix=prefix or f"obe_{uuid.uuid4().hex[:8]}", secret_hash="0" * 64,
        created_by_id=w.user_id,
    )
    session.add(row)
    await session.flush()
    return row.id


async def operated(session, organization_id, composition_id, user_id) -> uuid.UUID:
    """Give an existing composition a version in effect in ``production``, with its adoption and a feed key."""
    v, e = await _version(session, composition_id, user_id, 1, "1.0.0")
    w = World(user_id, organization_id, composition_id, (v,), (e,), composition_id, v, e)
    environment_id = await environment(session, w, adopted_version_id=v, adoption_ordinal=1)
    await adoption(session, w, environment_id, 1)
    await key(session, w, environment_id)
    await session.commit()
    return environment_id
