"""Forking a version of a composition into another organization, as a new composition there.

Ported in its rules from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a),
``PricingService.forkPricing``:

* a fork always creates a **new** composition in **another** organization; forking into the source's own
  organization is 409 ``composition_fork_same_organization`` (seal a new version instead);
* the caller must read the source (404 otherwise, as for any unreadable composition) and be a MEMBER of the
  target;
* without an explicit ``slug`` the fork takes the source's, and when the target already holds it nothing is
  written: the answer names the composition that holds it (``NameTaken``), so the caller can choose another.
  With an explicit ``slug`` a taken one is 409 ``slug_conflict``;
* the new version keeps an immutable snapshot of what it was forked from (``forked_from``), since names can
  change later, beside the lineage ids (``based_on``).

The fork's first version is the source's document with ``composition:`` set to the new slug, **sealed again
through the same pipeline** (the full reading, then :func:`~.assess.assess`), so one code path writes
versions and a fork is judged as any new seal: a ``from`` on a registry the deployment no longer defines is
refused. An assessment failure is a refusal (422), never a silent downgrade.

Problems are private to their organization and a document links a problem of its own organization only, so
a version that links a problem cannot keep its link in another organization: such a fork is 409
``composition_fork_problem_unreadable`` unless the caller sets ``dropProblem``, an explicit choice that
removes ``problem`` and ``evidence`` from the copy and seals its values as declared. The response and the
version (``forked_from.droppedProblem``) say so.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from typing import Any

from fastapi import status
from sqlalchemy.ext.asyncio import AsyncSession

from ....composition import text
from ....db.models import Composition, CompositionKind, CompositionVersion, Organization, User
from ....models.errors import api_error
from ...shared.application import audit
from .compositions import TARGET, insert_composition, require_repository, slug_holder
from .language import diagnostic_view
from .seal import Checked, Sealed, judge, seal_into
from .slots import language_slot


@dataclass(frozen=True)
class Forked:
    """The new composition, its first version and what judging the copy found."""

    composition: Composition
    sealed: Sealed
    checked: Checked
    dropped_problem: bool


@dataclass(frozen=True)
class NameTaken:
    """Nothing was forked: ``existing`` holds the slug the fork would take by default."""

    existing: Composition


def _copy(content: str, slug: str, drop_problem: bool) -> bytes:
    """The source's stored document renamed to ``slug`` (and unlinked when ``drop_problem``), canonical."""
    document = replace(text.read_stored(content), composition=slug)
    if drop_problem:
        document = replace(document, problem=None, evidence=None)
    return text.serialise(document).encode("utf-8")


def _snapshot(
    organization: Organization, composition: Composition, version: CompositionVersion, dropped_problem: bool,
) -> dict[str, Any]:
    return {
        "compositionId": str(composition.id),
        "versionId": str(version.id),
        "label": version.label,
        # SPHERE's organization ``name`` is its handle, the slug here; ``displayName`` its name.
        "organization": {"id": str(organization.id), "name": organization.slug, "displayName": organization.name},
        "slug": composition.slug,
        "name": composition.name,
        "droppedProblem": dropped_problem,
    }


async def fork_composition(
    session: AsyncSession,
    source_organization: Organization,
    source: Composition,
    version: CompositionVersion,
    target: Organization,
    *,
    actor: User,
    slug: str | None = None,
    name: str | None = None,
    description: str | None = None,
    drop_problem: bool = False,
) -> Forked | NameTaken:
    """Fork ``version`` of ``source`` into ``target`` as a new composition; committed.

    The caller has checked that ``actor`` reads the source and is a MEMBER of ``target``.
    """
    if target.id == source_organization.id:
        raise api_error(
            status.HTTP_409_CONFLICT, "composition_fork_same_organization",
            "A fork goes to another organization; to change this composition, seal a new version of it instead.",
        )
    linked = version.revision_id is not None
    if linked and not drop_problem:
        raise api_error(
            status.HTTP_409_CONFLICT, "composition_fork_problem_unreadable",
            "This version links a problem of its own organization, which the target organization cannot read. "
            "Set `dropProblem` to fork it without its problem and evidence, with its values declared.",
        )
    await require_repository(actor)
    wanted = slug or source.slug
    holder = await slug_holder(session, target.id, wanted)
    if holder is not None:
        if slug is None:
            return NameTaken(holder)
        raise api_error(
            status.HTTP_409_CONFLICT, "slug_conflict", "That composition slug is in use in this organization.",
        )

    async with language_slot():
        raw = await asyncio.to_thread(_copy, version.content, wanted, linked)
    checked = await judge(session, target, wanted, raw, actor)
    assessment = checked.assessment
    if not checked.valid or assessment is None or assessment.effective is None:
        raise api_error(
            422, "composition_invalid", "The forked document has errors; `diagnostics` says where.",
            diagnostics=[diagnostic_view(item) for item in checked.diagnostics],
        )

    based_on = {"composition_id": str(source.id), "version_id": str(version.id), "label": version.label}
    snapshot = _snapshot(source_organization, source, version, linked)
    # Phase 1 read in a transaction of its own; the composition and its version are one transaction.
    await session.commit()
    composition = await insert_composition(
        session, target, actor,
        slug=wanted,
        name=name or source.name,
        description=source.description if description is None else description,
        kind=CompositionKind(assessment.effective.kind),
    )
    sealed = await seal_into(session, composition, assessment, actor=actor, based_on=based_on, forked_from=snapshot)
    audit(
        session, actor, "composition.forked", TARGET, composition.id, target.id,
        source_organization_id=str(source_organization.id), source_composition_id=str(source.id),
        source_version_id=str(version.id), label=version.label, dropped_problem=linked,
    )
    await session.commit()
    await session.refresh(composition, ["updated_at"])
    return Forked(composition, sealed, checked, linked)


__all__ = ["Forked", "NameTaken", "fork_composition"]
