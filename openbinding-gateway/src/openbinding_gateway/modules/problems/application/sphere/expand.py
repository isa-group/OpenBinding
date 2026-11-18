"""Preview and apply a SPHERE import recipe on a problem: ``sphere/expand``, ``sphere/apply``, ``sphere/recipe``.

**Expand** parses the recipe, resolves ``latest`` and snapshots every pricing it names through ``plans.application``
(before any compile and outside any transaction, one source after another under a 30 s deadline; an unreadable one
is ``sphere_source_unreadable`` with its reason), generates the package over the base revision's files, compiles it
with the installed toolchain and answers the candidates, the requirement explanations, the changes against the
base, the facts with their value sources and the package digest. Compiler refusals come back as located findings
with a 200: a preview never fails on what it previews.

**Apply** stores exactly what a preview showed: the recipe must be pinned, the snapshots are the stored ones (no
SPHERE call when the preview ran), the regenerated package digest must equal ``expect.packageDigest`` (else 409
``sphere_preview_stale``); a revision that already has that package digest is answered with 200 (a retried apply is
idempotent); a new problem's slug must be free (409 ``problem_exists``); otherwise the revision is added with
``expected_latest = base.revision``, checked under the problem lock (409 ``revision_moved``). The revision carries
the pinned recipe in its provenance (producer ``openbinding-sphere-import``, origin ``sphere``) and one value origin
per generated value.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from bim_core import PackageError
from bim_core.package import load_package
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .....db.models import BindingCase, BindingCaseRevision, Blob, Organization, PricingSnapshot, User
from .....models.errors import api_error
from ....plans.application import (
    PricingInvalid,
    PricingNotFound,
    PricingSourceBusy,
    PricingSourceUnavailable,
    SphereEndpoint,
    credential_for,
    discovery,
    get_pricing_source,
    normalised,
    snapshot_version,
)
from ....shared.application import audit, read_verified
from ...domain.compilation import analysis_summary
from ...domain.origin import SPHERE_PRODUCER
from ...domain.sphere.diagnostics import SphereDiagnostic, diagnostic, has_errors
from ...domain.sphere.recipe import Recipe, SphereRef, parse_recipe, pinned, recipe_digest, require_pinned
from ..compile import compile_package, compile_refusal
from ..facts import compilation_facts
from ..problems import SLUG, Upload, add_revision, compile_or_get, create_problem, problem_by_ref
from .generate import GENERATOR_VERSION, Generated, SnapshotMeta, SourceKey, SourcePricing, generate

EXPAND_DEADLINE_S = 30.0


# -- Sources -------------------------------------------------------------------------------------------------------


@dataclass
class Resolved:
    sources: dict[SourceKey, SourcePricing] = field(default_factory=dict)
    snapshots: dict[SourceKey, PricingSnapshot] = field(default_factory=dict)
    pinned: dict[tuple[str | None, str], str] = field(default_factory=dict)
    diagnostics: list[SphereDiagnostic] = field(default_factory=list)


def _unreadable(at: str, reason: str, message: str, **extra: Any) -> SphereDiagnostic:
    return diagnostic("sphere_source_unreadable", message, at, reason=reason, **extra)


def _refs(recipe: Recipe) -> list[tuple[SphereRef, str]]:
    """Each distinct pricing reference with the pointer of the first source naming it."""
    seen: dict[tuple[str | None, str, str], tuple[SphereRef, str]] = {}
    for _, source in recipe.sphere_sources():
        assert source.sphere is not None
        seen.setdefault(source.sphere.key, (source.sphere, source.at))
    return list(seen.values())


async def resolve_sources(
    session: AsyncSession,
    organization_id: uuid.UUID,
    recipe: Recipe,
    actor_id: uuid.UUID,
    *,
    read_manifests: bool,
    deadline_s: float = EXPAND_DEADLINE_S,
) -> Resolved:
    """Snapshot every pricing ``recipe`` names (``latest`` resolved first); with ``read_manifests`` each family's
    manifest is read too (its latest version and permanent link), which apply never does."""
    resolved = Resolved()
    registries = set(get_pricing_source().registries())
    credential = None
    started = time.monotonic()
    for ref, at in _refs(recipe):
        remaining = deadline_s - (time.monotonic() - started)
        if remaining <= 0:
            resolved.diagnostics.append(_unreadable(at, "deadline", "SPHERE took too long; this pricing was not read."))
            continue
        if ref.registry is not None and ref.registry not in registries:
            resolved.diagnostics.append(_unreadable(at, "registry_unknown", f"No SPHERE registry is configured as {ref.registry}."))
            continue
        where = SphereEndpoint(ref.registry)
        if ref.registry is None and credential is None:
            credential = await credential_for(session, organization_id)
        keyed = credential if ref.registry is None else None
        try:
            async with asyncio.timeout(remaining):
                latest = None
                if read_manifests or not ref.pinned:
                    manifest = await discovery.manifest(where, ref.pricing, keyed)
                    latest = manifest.latest_version_id
                version = ref.version if ref.pinned else latest
                assert version is not None
                taken = await snapshot_version(session, organization_id, where, ref.pricing, version, keyed,
                                               actor_id=actor_id)
                parsed = await normalised(taken.snapshot)
        except TimeoutError:
            resolved.diagnostics.append(_unreadable(at, "deadline", "SPHERE took too long; this pricing was not read."))
            continue
        except PricingNotFound:
            resolved.diagnostics.append(_unreadable(at, "not_found", "This pricing version is not found or not visible."))
            continue
        except PricingSourceBusy as exc:
            resolved.diagnostics.append(_unreadable(at, "busy", f"SPHERE is busy; try again in {exc.retry_after} s.",
                                                    retryAfter=exc.retry_after))
            continue
        except PricingSourceUnavailable as exc:
            resolved.diagnostics.append(_unreadable(at, "unavailable", f"SPHERE cannot be read right now ({exc.reason})."))
            continue
        except PricingInvalid as exc:
            resolved.diagnostics.append(diagnostic("sphere_pricing_invalid", exc.message, at))
            continue
        if not ref.pinned:
            resolved.pinned[(ref.registry, ref.pricing)] = version
        snapshot = taken.snapshot
        meta = SnapshotMeta(
            pricing_id=ref.pricing,
            version_id=version,
            registry=ref.registry,
            snapshot_id=str(snapshot.id),
            owner=snapshot.owner,
            slug=snapshot.slug,
            title=snapshot.title,
            version_label=snapshot.version_label or "",
            permanent_url=get_pricing_source().permanent_url(where, ref.pricing, version),
            latest_version_id=latest,
            content_hash_verified=bool(snapshot.content_hash_verified),
        )
        refusal = (parsed.refusal.code, parsed.refusal.message) if parsed.refusal is not None else None
        key = (ref.registry, ref.pricing, version)
        resolved.sources[key] = SourcePricing(meta, parsed.normalised, refusal)
        resolved.snapshots[key] = snapshot
        if not ref.pinned:
            # The pinned recipe names the version; generate reads the source under the pinned key.
            resolved.sources[ref.key] = resolved.sources[key]
    return resolved


# -- Base ------------------------------------------------------------------------------------------------------------


@dataclass
class Base:
    revision: BindingCaseRevision
    files: dict[str, bytes]
    previous_recipe: Recipe | None


async def _files_of(session: AsyncSession, revision: BindingCaseRevision) -> dict[str, bytes]:
    blob = await session.get(Blob, revision.package_blob_id)
    if blob is None:
        raise api_error(409, "content_unavailable", "The stored package of this revision is unavailable.")
    try:
        return dict(load_package(read_verified(blob)).files)
    except PackageError as exc:  # pragma: no cover - a stored package was read once already
        raise api_error(409, "content_unavailable", "The stored package of this revision cannot be read.") from exc


def _recipe_of(revision: BindingCaseRevision) -> Recipe | None:
    provenance = revision.provenance or {}
    if provenance.get("producer") != SPHERE_PRODUCER or not isinstance(provenance.get("recipe"), Mapping):
        return None
    recipe, _ = parse_recipe(provenance["recipe"])
    return recipe


async def latest_sphere_revision(
    session: AsyncSession, problem: BindingCase, at_most: int | None = None
) -> BindingCaseRevision | None:
    """The newest revision (up to ``at_most``) whose provenance holds a SPHERE recipe."""
    query = select(BindingCaseRevision).where(BindingCaseRevision.binding_case_id == problem.id)
    if at_most is not None:
        query = query.where(BindingCaseRevision.revision <= at_most)
    for revision in (await session.scalars(query.order_by(BindingCaseRevision.revision.desc()))).all():
        if _recipe_of(revision) is not None:
            return revision
    return None


async def _base(session: AsyncSession, problem: BindingCase, number: int) -> Base:
    revision = await session.scalar(select(BindingCaseRevision).where(
        BindingCaseRevision.binding_case_id == problem.id, BindingCaseRevision.revision == number,
    ))
    if revision is None:
        raise api_error(404, "not_found", "Problem revision not found.")
    previous = await latest_sphere_revision(session, problem, number)
    return Base(revision, await _files_of(session, revision), _recipe_of(previous) if previous else None)


async def _target(
    session: AsyncSession, organization: Organization, slug: str, base: int | None
) -> tuple[BindingCase | None, Base | None]:
    problem = await problem_by_ref(session, organization.id, slug)
    if base is None:
        if problem is not None:
            raise api_error(409, "problem_exists", "A problem with that slug exists; name the revision to build on (base).")
        if not SLUG.match(slug):
            raise api_error(422, "invalid_slug", "A slug is 1 to 64 lowercase letters, digits and hyphens.")
        return None, None
    if problem is None:
        raise api_error(404, "not_found", "Problem not found.")
    return problem, await _base(session, problem, base)


# -- Views -----------------------------------------------------------------------------------------------------------


def generated_sources(
    origins: list[Mapping[str, Any]], metas: Mapping[str, SnapshotMeta]
) -> tuple[dict[tuple[str, str, str], dict[str, Any]], dict[str, dict[str, Any]]]:
    """The value sources and provenance of a generated (not yet stored) package, as the facts take them."""
    sources: dict[tuple[str, str, str], dict[str, Any]] = {}
    provenance: dict[str, dict[str, Any]] = {}
    for origin in origins:
        meta = metas.get(origin.get("versionId") or "")
        pricing = None
        if origin.get("pricingId"):
            pricing = {
                "sphere": origin.get("sphereRef"), "registry": origin.get("registry"),
                "pricingId": origin["pricingId"], "versionId": origin.get("versionId"),
                "versionLabel": meta.version_label if meta else None, "plan": origin.get("plan"),
                "addOns": list(origin.get("addOns") or []), "permanentUrl": meta.permanent_url if meta else None,
            }
        sources[(origin["candidateKey"], origin["targetKind"], origin["target"])] = {
            "kind": origin["sourceKind"], "pricing": pricing, "detail": dict(origin.get("detail") or {}), "carried": False,
        }
        if origin["sourceKind"] != "manual" and pricing is not None and origin["candidateKey"] not in provenance:
            entry: dict[str, Any] = {
                "sphere": pricing["sphere"], "version": pricing["versionId"], "versionLabel": pricing["versionLabel"],
                "plan": pricing["plan"], "pricingId": pricing["pricingId"], "snapshot": origin.get("snapshot"),
                "permanentUrl": pricing["permanentUrl"],
            }
            if pricing["registry"]:
                entry["registry"] = pricing["registry"]
            if pricing["addOns"]:
                entry["addons"] = pricing["addOns"]
            provenance[origin["candidateKey"]] = entry
    return sources, provenance


def _changes(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None) -> dict[str, Any]:
    """Added, removed and changed candidates (values and properties) of the new facts against the base's."""
    if after is None:
        return {"added": [], "removed": [], "changed": []}
    old = {c["key"]: c for c in (before or {}).get("candidates", [])}
    new = {c["key"]: c for c in after.get("candidates", [])}
    changed = []
    for key in sorted(set(old) & set(new)):
        diff: dict[str, Any] = {}
        for member in ("values", "properties"):
            a, b = old[key].get(member) or {}, new[key].get(member) or {}
            moved = {name: {"before": a.get(name), "after": b.get(name)} for name in sorted(set(a) | set(b)) if a.get(name) != b.get(name)}
            if moved:
                diff[member] = moved
        if diff:
            changed.append({"key": key, **diff})
    return {"added": sorted(set(new) - set(old)), "removed": sorted(set(old) - set(new)), "changed": changed}


def snapshot_view(snapshot: PricingSnapshot, meta: SnapshotMeta) -> dict[str, Any]:
    return {
        "id": str(snapshot.id),
        "pricingId": snapshot.pricing_id,
        "versionId": snapshot.version_id,
        "versionName": snapshot.version_label,
        "createdAt": snapshot.version_created_at,
        "title": snapshot.title,
        "owner": snapshot.owner,
        "slug": snapshot.slug,
        "registry": snapshot.registry,
        "currency": snapshot.currency,
        "syntaxVersion": snapshot.syntax_version,
        "latest": None if meta.latest_version_id is None else meta.latest_version_id == meta.version_id,
        "permanentUrl": meta.permanent_url,
    }


def _merged(read: list[SphereDiagnostic], generated: list[SphereDiagnostic]) -> list[SphereDiagnostic]:
    """The reading's findings and the generator's, the generator's own "not read" dropped where the reading said
    why."""
    said = {d.at for d in read if d.code == "sphere_source_unreadable"}
    kept = [d for d in generated if not (d.code == "sphere_source_unreadable" and d.at in said)]
    return sorted(read + kept, key=lambda d: (d.at, d.code, d.message))


def _refusal_diagnostics(exc: HTTPException) -> list[dict[str, Any]]:
    refusal = compile_refusal(exc)
    found = [dict(item, severity="error") for item in refusal.diagnostics]
    return found or [{"code": refusal.code, "severity": "error", "message": refusal.message, "at": ""}]


@dataclass
class Preview:
    recipe: Recipe | None
    generated: Generated | None
    view: dict[str, Any]


async def expand(
    session: AsyncSession,
    organization: Organization,
    slug: str,
    recipe_document: Any,
    base: int | None,
    caller: User,
) -> Preview:
    """The preview of ``recipe_document`` on the problem ``slug`` (``base`` its revision, or ``None`` for a new one)."""
    problem, found_base = await _target(session, organization, slug, base)
    recipe, problems = parse_recipe(recipe_document)
    empty = {"valid": False, "recipe": None, "recipeDigest": None, "packageDigest": None, "snapshots": [],
             "candidates": [], "changes": {"added": [], "removed": [], "changed": []}, "facts": None}
    if recipe is None:
        return Preview(None, None, {**empty, "diagnostics": [p.as_dict() for p in problems]})
    organization_id, caller_id = organization.id, caller.id
    await session.commit()
    resolved = await resolve_sources(session, organization_id, recipe, caller_id, read_manifests=True)
    stored = pinned(recipe, resolved.pinned) if resolved.pinned else recipe
    generated = generate(stored, resolved.sources, found_base.files if found_base else None,
                         found_base.previous_recipe if found_base else None, name=slug)
    diagnostics = [d.as_dict() for d in _merged(resolved.diagnostics, generated.diagnostics)]
    view: dict[str, Any] = {
        **empty,
        "recipe": dict(stored.document),
        "recipeDigest": recipe_digest(stored),
        "snapshots": [snapshot_view(resolved.snapshots[k], resolved.sources[k].meta) for k in sorted(
            resolved.snapshots, key=lambda k: (k[0] or "", k[1], k[2]))],
        "candidates": generated.candidates,
        "diagnostics": diagnostics,
    }
    if not generated.valid or has_errors(resolved.diagnostics):
        return Preview(stored, generated, view)
    try:
        compilation = await compile_package(generated.archive())
    except HTTPException as exc:
        if exc.status_code >= 500:
            raise
        view["diagnostics"] = diagnostics + _refusal_diagnostics(exc)
        return Preview(stored, generated, view)
    metas = {s.meta.version_id: s.meta for s in resolved.sources.values()}
    sources, provenance = generated_sources(generated.origins, metas)
    facts = compilation_facts(
        compilation.ir, compilation.source_map, analysis_summary(compilation.ir, compilation.analysis),
        ir_digest=compilation.ir_digest, sources=sources, provenance=provenance,
    )
    before = None
    if found_base is not None:
        row = await compile_or_get(session, found_base.revision, release_transaction=True)
        before = compilation_facts(row.ir, row.source_map, analysis_summary(row.ir, row.analysis), ir_digest=row.ir_digest)
    view.update(valid=True, packageDigest=compilation.package_digest, facts=facts, changes=_changes(before, facts))
    return Preview(stored, generated, view)


# -- Apply -----------------------------------------------------------------------------------------------------------


def _refuse(code: str, message: str, diagnostics: list[SphereDiagnostic | dict[str, Any]]) -> HTTPException:
    items = [d.as_dict() if isinstance(d, SphereDiagnostic) else d for d in diagnostics]
    return api_error(422, code, message, diagnostics=items)


async def apply(
    session: AsyncSession,
    organization: Organization,
    slug: str,
    recipe_document: Any,
    base: int | None,
    expect_digest: str,
    caller: User,
    *,
    name: str | None = None,
) -> Upload:
    """Store what the preview of the same recipe showed (see the module docstring)."""
    recipe, problems = parse_recipe(recipe_document)
    if recipe is None:
        raise _refuse("sphere_recipe_invalid", "The recipe is not valid.", problems)
    unpinned = require_pinned(recipe)
    if unpinned:
        raise _refuse("sphere_recipe_invalid", "A stored recipe names every pricing version.", unpinned)
    problem = await problem_by_ref(session, organization.id, slug)
    found_base = await _base(session, problem, base) if (problem is not None and base is not None) else None
    if base is not None and problem is None:
        raise api_error(404, "not_found", "Problem not found.")
    organization_id, caller_id = organization.id, caller.id
    await session.commit()
    resolved = await resolve_sources(session, organization_id, recipe, caller_id, read_manifests=False)
    generated = generate(recipe, resolved.sources, found_base.files if found_base else None,
                         found_base.previous_recipe if found_base else None, name=slug)
    findings = _merged(resolved.diagnostics, generated.diagnostics)
    if has_errors(findings) or not generated.files:
        raise _refuse("sphere_recipe_refused", "The recipe cannot be applied as it is.", findings)
    archive = generated.archive()
    digest = load_package(archive).package_digest
    if digest != expect_digest:
        raise api_error(409, "sphere_preview_stale",
                        "What this recipe generates now differs from the preview; preview it again.", packageDigest=digest)
    if problem is not None:
        existing = await session.scalar(select(BindingCaseRevision).where(
            BindingCaseRevision.binding_case_id == problem.id, BindingCaseRevision.package_digest == digest,
        ))
        if existing is not None:
            upload = await add_revision(session, problem, archive, caller)
            return upload
        if base is None:
            raise api_error(409, "problem_exists", "A problem with that slug exists; name the revision to build on (base).")
    provenance = {
        "producer": SPHERE_PRODUCER,
        "recipe": dict(recipe.document),
        "recipeDigest": recipe_digest(recipe),
        "generator": GENERATOR_VERSION,
        # In the order of their sources (registry, pricing, version), not of their random ids.
        "snapshots": list(dict.fromkeys(
            str(resolved.snapshots[key].id) for key in sorted(resolved.snapshots, key=lambda k: (k[0] or "", k[1], k[2]))
        )),
        "sources": [
            {"title": meta.title, "versionLabel": meta.version_label, "pricingId": meta.pricing_id,
             "versionId": meta.version_id, "registry": meta.registry}
            for meta in generated.sources
        ],
    }
    if problem is None:
        upload = await create_problem(
            session, await session.get(Organization, organization_id), archive, await session.get(User, caller_id),
            slug=slug, name=name, provenance=provenance, value_origins=generated.origins,
        )
    else:
        upload = await add_revision(
            session, problem, archive, await session.get(User, caller_id), provenance=provenance,
            value_origins=generated.origins, expected_latest=base,
        )
    if upload.created:
        audit(session, await session.get(User, caller_id), "problem.sphere_applied", "BindingCaseRevision",
              upload.revision.id, organization_id, problem=str(upload.problem.id), revision=upload.revision.revision,
              recipeDigest=provenance["recipeDigest"])
        await session.commit()
    return upload


# -- Recipe ----------------------------------------------------------------------------------------------------------


async def recipe_of(session: AsyncSession, problem: BindingCase, revision: int | None = None) -> tuple[BindingCaseRevision, Recipe]:
    """The pinned recipe of revision ``revision``, or of the newest revision a SPHERE import generated."""
    if revision is None:
        found = await latest_sphere_revision(session, problem)
    else:
        found = await session.scalar(select(BindingCaseRevision).where(
            BindingCaseRevision.binding_case_id == problem.id, BindingCaseRevision.revision == revision,
        ))
    recipe = _recipe_of(found) if found is not None else None
    if found is None or recipe is None:
        raise api_error(404, "not_found", "No SPHERE recipe generated this problem's revision.")
    return found, recipe


__all__ = [
    "EXPAND_DEADLINE_S",
    "Preview",
    "apply",
    "expand",
    "generated_sources",
    "latest_sphere_revision",
    "recipe_of",
    "resolve_sources",
]
