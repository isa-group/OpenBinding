"""Composition templates: a problem and a composition derived from it, made in one human action.

A template is a manifest ``examples/templates/<id>.json`` (``resources/composition-templates/1.0``): the problem
(a JSON file map or a package directory under ``examples/``, then SPHERE import recipes applied in order) and the
composition derived from a binding of its latest revision, with an optional offering. It is a catalog of its own,
apart from the BIM templates (``problems.application.templates``): a manifest adds no ``instance.json`` anywhere,
so the BIM corpus does not change.

``instantiate`` calls only the platform's own services, in the order a member would: create the problem, preview
and apply each recipe (``sphere/expand`` and ``sphere/apply``), derive the binding, read the offering (the seal
pre-phase), then create the composition and seal its first version in one transaction, as a fork does. It writes
no environment: the manifest's ``operation`` hints are only defaults for a later environment form. The lab seed
and the frontend fixture dumper call the same function, so the lab, the fixtures and the template take one path.

Before anything is written, a taken composition or problem slug is 409 ``slug_conflict`` (with ``field``) and a
template that reads SPHERE while SPHERE is off is 409 ``template_needs_sphere``. Once the problem exists, any
failure leaves it (a visible resource the member may delete) and answers 502 ``template_incomplete`` naming what
exists; the composition is never created without its version.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import (
    BindingCaseRevision,
    Composition,
    CompositionKind,
    Organization,
    User,
)
from ....integrations import packages
from ....models.errors import api_error
from ...plans.application import installed_pricing_source
from ...problems.application import (
    create_problem,
    dump_document,
    examples_root,
    problem_by_ref,
    sphere_apply,
    sphere_expand,
)
from ...shared.application import audit
from .compositions import TARGET, insert_composition, require_repository, slug_holder
from .derive import derive_version
from .offering import before_seal
from .seal import Sealed, seal_into

#: The manifests' directory, under the repository's (or the image's) ``examples/``.
TEMPLATES_DIR = "templates"
TEMPLATE_ID = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
SCHEMA = Path(__file__).resolve().parents[1] / "resources" / "composition-templates" / "1.0" / "template.schema.json"
#: The producer a template's revision 1 records in its provenance.
PRODUCER = "openbinding-composition-template"
#: What ``requires`` may name, and why each would make a template unavailable.
SPHERE = "sphere"
SPHERE_DISABLED = "sphere_disabled"


@dataclass(frozen=True)
class Template:
    """One manifest, validated against the schema; its paths are confined to ``examples/``."""

    id: str
    title: str
    summary: str
    kind: str
    problem: Mapping[str, Any]
    composition: Mapping[str, Any]
    operation: Mapping[str, Any] = field(default_factory=dict)
    requires: tuple[str, ...] = ()

    @property
    def tasks(self) -> list[str]:
        return list(self.composition["binding"])

    @property
    def has_offering(self) -> bool:
        return "offering" in self.composition

    @property
    def recipes(self) -> list[str]:
        return list(self.problem.get("recipes") or [])


@dataclass(frozen=True)
class Availability:
    available: bool
    reason: str | None = None


@dataclass(frozen=True)
class Instantiated:
    """What one instantiation made: the problem and its latest revision, the composition and its version."""

    template: Template
    problem_slug: str
    revision: BindingCaseRevision
    composition: Composition
    sealed: Sealed


def _not_found() -> HTTPException:
    return api_error(status.HTTP_404_NOT_FOUND, "not_found", "Template not found.")


def _confined(relative: str) -> Path:
    """``examples/<relative path>`` resolved inside ``examples/``; anything else is a broken manifest."""
    root = examples_root().resolve()
    if not relative.startswith("examples/"):
        raise ValueError(f"{relative!r} is not under examples/")
    resolved = (root / relative.removeprefix("examples/")).resolve()
    resolved.relative_to(root)  # ValueError outside
    return resolved


@lru_cache(maxsize=1)
def _validator():
    import jsonschema

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    return jsonschema.Draft202012Validator(schema)


def _parse(document: Any, expected_id: str) -> Template:
    errors = sorted(_validator().iter_errors(document), key=lambda error: list(error.absolute_path))
    if errors:
        raise ValueError(f"{expected_id}: {errors[0].message} at /{'/'.join(map(str, errors[0].absolute_path))}")
    if document["id"] != expected_id:
        raise ValueError(f"{expected_id}: the manifest's id is {document['id']!r}")
    problem = document["problem"]
    for relative in [problem.get("bundle"), problem.get("package"), *(problem.get("recipes") or [])]:
        if relative is not None:
            _confined(relative)
    return Template(
        id=document["id"], title=document["title"], summary=document["summary"], kind=document["kind"],
        problem=problem, composition=document["composition"], operation=document.get("operation") or {},
        requires=tuple(document.get("requires") or ()),
    )


def _directory() -> Path:
    return examples_root() / TEMPLATES_DIR


def catalog() -> list[Template]:
    """Every manifest of ``examples/templates``, by id."""
    directory = _directory()
    if not directory.is_dir():
        return []
    found = []
    for path in sorted(directory.glob("*.json")):
        if TEMPLATE_ID.fullmatch(path.stem):
            found.append(_parse(json.loads(path.read_text(encoding="utf-8")), path.stem))
    return found


def template(template_id: str) -> Template:
    """One template by id; an id outside the catalog (``..`` included) is 404."""
    if not TEMPLATE_ID.fullmatch(template_id):
        raise _not_found()
    path = _directory() / f"{template_id}.json"
    if not path.is_file():
        raise _not_found()
    return _parse(json.loads(path.read_text(encoding="utf-8")), template_id)


def sphere_available() -> bool:
    """Whether SPHERE is on: a pricing source is installed and not switched off."""
    source = installed_pricing_source()
    return source is not None and source.state() != "disabled"


def availability(found: Template) -> Availability:
    if SPHERE in found.requires and not sphere_available():
        return Availability(False, SPHERE_DISABLED)
    return Availability(True)


def archive_of(found: Template) -> bytes:
    """The problem's revision 1 as a ``.bim.zip``: the JSON file map zipped, or the package directory."""
    problem = found.problem
    if "bundle" in problem:
        bundle = json.loads(_confined(problem["bundle"]).read_text(encoding="utf-8"))
        return packages.zip_files({path: dump_document(document) for path, document in bundle.items()})
    return packages.zip_directory(_confined(problem["package"]))


def recipe_documents(found: Template) -> list[Any]:
    return [json.loads(_confined(relative).read_text(encoding="utf-8")) for relative in found.recipes]


def _slug_conflict(field_name: str, what: str) -> HTTPException:
    return api_error(
        status.HTTP_409_CONFLICT, "slug_conflict", f"That {what} slug is in use in this organization.", field=field_name,
    )


def _incomplete(problem_slug: str, revision: int | None, cause: HTTPException | Exception) -> HTTPException:
    detail = getattr(cause, "detail", None)
    code = detail.get("code") if isinstance(detail, dict) else None
    return api_error(
        status.HTTP_502_BAD_GATEWAY, "template_incomplete",
        "The template stopped after its problem was created; the problem is kept and no composition was made.",
        problem=problem_slug, revision=revision, cause=code or type(cause).__name__,
    )


async def _latest(session: AsyncSession, problem_id: uuid.UUID) -> int:
    return int(await session.scalar(
        select(func.max(BindingCaseRevision.revision)).where(BindingCaseRevision.binding_case_id == problem_id)
    ) or 1)


async def instantiate(
    session: AsyncSession,
    organization: Organization,
    actor: User,
    template_id: str,
    *,
    slug: str | None = None,
    name: str | None = None,
    problem_slug: str | None = None,
) -> Instantiated:
    """The template's problem and composition, made for ``organization`` by ``actor`` (module docstring).

    The caller has checked that ``actor`` is a MEMBER of ``organization``.
    """
    found = template(template_id)
    if not availability(found).available:
        raise api_error(
            status.HTTP_409_CONFLICT, "template_needs_sphere",
            "This template reads SPHERE, which is not enabled on this deployment.", template=found.id,
        )
    spec = found.composition
    slug = slug or spec["slug"]
    problem_slug = problem_slug or found.problem["slug"]
    await require_repository(actor)
    if await slug_holder(session, organization.id, slug) is not None:
        raise _slug_conflict("slug", "composition")
    if await problem_by_ref(session, organization.id, problem_slug) is not None:
        raise _slug_conflict("problemSlug", "problem")
    archive = archive_of(found)
    recipes = recipe_documents(found)
    organization_id, actor_id = organization.id, actor.id

    upload = await create_problem(
        session, organization, archive, actor, slug=problem_slug, name=found.problem["name"],
        description=found.problem.get("description", ""),
        provenance={"producer": PRODUCER, "template": found.id},
    )
    problem = upload.problem
    revision_number = upload.revision.revision
    try:
        for recipe in recipes:
            organization = await session.get(Organization, organization_id)
            actor = await session.get(User, actor_id)
            base = await _latest(session, problem.id)
            preview = await sphere_expand(session, organization, problem_slug, recipe, base, actor)
            if not preview.view["valid"]:
                errors = [d for d in preview.view["diagnostics"] if d.get("severity") == "error"]
                raise api_error(
                    422, (errors[0]["code"] if errors else "sphere_recipe_refused"),
                    "A recipe of the template does not preview.",
                )
            applied = await sphere_apply(
                session, organization, problem_slug, recipe, base, preview.view["packageDigest"], actor,
            )
            revision_number = applied.revision.revision
        organization = await session.get(Organization, organization_id)
        actor = await session.get(User, actor_id)
        revision = await session.scalar(select(BindingCaseRevision).where(
            BindingCaseRevision.binding_case_id == problem.id, BindingCaseRevision.revision == revision_number,
        ))
        kind = CompositionKind(found.kind)
        # Derived against the composition it will become, not yet stored: the composition and its first version
        # are one transaction below, as a fork's are.
        pending = Composition(slug=slug, name=name or spec["name"], kind=kind, organization_id=organization_id)
        derived = await derive_version(
            session, organization, pending, caller=actor, label=spec["label"], kind=kind.value,
            offering=spec.get("offering"), revision=f"{problem_slug}@{revision_number}", binding=dict(spec["binding"]),
        )
        assessment = await before_seal(session, organization, derived.assessment, actor, source=derived.content)
        await session.commit()
        organization = await session.get(Organization, organization_id)
        actor = await session.get(User, actor_id)
        composition = await insert_composition(
            session, organization, actor, slug=slug, name=name or spec["name"],
            description=spec.get("description", ""), kind=kind,
        )
        sealed = await seal_into(session, composition, assessment, actor=actor, derivation=derived.derivation)
        audit(
            session, actor, "composition.instantiated", TARGET, composition.id, organization_id,
            template=found.id, problem=problem_slug, revision=revision_number, label=sealed.version.label,
        )
        await session.commit()
        await session.refresh(composition, ["updated_at"])
    except HTTPException as exc:
        await session.rollback()
        raise _incomplete(problem_slug, revision_number, exc) from exc
    return Instantiated(found, problem_slug, revision, composition, sealed)


__all__ = [
    "Availability",
    "Instantiated",
    "Template",
    "availability",
    "catalog",
    "instantiate",
    "sphere_available",
    "template",
]
