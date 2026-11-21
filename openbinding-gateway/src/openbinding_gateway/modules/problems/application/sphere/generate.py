"""Generate an ordinary BIM package (``qos-binding/v1``) from a recipe and the normalised pricings it names.

Pure in behaviour and deterministic: no I/O, no session, no clock. The same recipe over the same pricings (and the
same base package) always gives the same bytes: canonical JSON (sorted keys, 2-space indent, ``\\n``), fixed file
names, candidates by id. It lives in ``problems.application`` only because it reads ``plans``' normaliser, which a
``modules.*.domain`` may not import.

**A new problem** (``base`` is ``None``) gets ``instance.json``, ``application.json`` (one service task per recipe
task, a JSON ``sequence`` workflow in recipe order, one feature per recipe feature), one catalog
``sphere-<service>`` per service and ``optimization.json`` (one criterion per feature).

**An existing problem** (``base`` = the base revision's files) changes only what the generator owns: the catalogs
``sphere-<service>`` of the recipe's services (replaced wholesale), the ``requires.predicate`` of the recipe's tasks,
the features the recipe declares (added when missing; an existing one must agree), and wider domains and
``normalize`` bounds (``sphere_rescaled``). A predicate or a ``sphere-<service>`` resource it did not write itself
(per ``previous_recipe``, the latest SPHERE recipe of the problem) is refused, never overwritten.

**Values** (plan §2.8): ``price`` is the subscription per month, ``(plan + add-on)`` with each part made monthly
(``/year`` / 12, ``/week`` x 52 / 12), per-seat parts times the seats, times the billing multiplier; a metered
add-on is never a part. ``limit`` reads a usage limit (unlimited is ``1e8`` for a property, ``unlimitedAs`` for a
feature); ``feature`` a feature's value; ``guarantee`` a guarantee through its table or scale; constants and values
set by hand are ``manual``. **Requirements** become the task's compile-time ``requires.predicate``, the demand
written as a literal: eligibility is the compiler's, and ``requirements`` only explains it.

The recipe's digest goes into ``instance.json`` ``metadata.annotations["openbinding.org/sphere-recipe"]``, so the
same recipe gives the same package and another recipe another package. Snapshot digests, content hashes, version
ids and pricing titles are never written into the package: a SPHERE rename does not make a new revision.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ....plans.application import pricing2yaml as p2y
from ...domain.sphere import ids
from ...domain.sphere.diagnostics import SphereDiagnostic, diagnostic, has_errors, pointer
from ...domain.sphere.recipe import (
    PropertySpec,
    Recipe,
    Source,
    Task,
    recipe_digest,
)
from .candidate import (
    SnapshotMeta,
    _Candidate,
    _Context,
    _explain,
    _literal,
    _number,
    _origin,
    _plain,
    admit_add_on,
    admit_plan,
    judge,
    task_specs,
)

GENERATOR_VERSION = "1"
DIMENSIONLESS = "1"
RECIPE_ANNOTATION = "openbinding.org/sphere-recipe"
QOS = "qos-binding/v1"
MAX_CANDIDATES_PER_SOURCE = 50
MAX_PACKAGE_ENTRIES = 256
MAX_PACKAGE_BYTES = 16 * 1024 * 1024
MAX_PREDICATE_CHARS = 4096
MAX_PREDICATE_TERMS = 32

#: ``(registry, pricingId, versionId)``.
SourceKey = tuple[str | None, str, str]




@dataclass(frozen=True)
class SourcePricing:
    """A source as read: its normalised pricing, or the normaliser's refusal (``code``, ``message``)."""

    meta: SnapshotMeta
    pricing: p2y.NormalisedPricing | None
    refusal: tuple[str, str] | None = None


@dataclass
class Generated:
    files: dict[str, bytes]
    origins: list[dict[str, Any]]
    candidates: list[dict[str, Any]]
    requirements: dict[str, list[dict[str, Any]]]
    diagnostics: list[SphereDiagnostic]
    predicates: dict[str, str | None] = field(default_factory=dict)
    recipe_digest: str = ""
    sources: list[SnapshotMeta] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not has_errors(self.diagnostics) and bool(self.files)

    def archive(self) -> bytes:
        from .....integrations.packages import zip_files

        return zip_files(self.files)


# -- JSON ------------------------------------------------------------------------------------------------------------






def dump(document: Any) -> bytes:
    """Canonical JSON of a package file: sorted keys, 2-space indent, a final newline."""
    return (json.dumps(_plain(document), sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _load(files: Mapping[str, bytes], path: str) -> dict[str, Any]:
    value = json.loads(files[path])
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def nice(value: float) -> float:
    """The smallest 1, 2 or 5 x 10^k at least ``value`` (1 for nothing positive): bounds that small price changes
    do not move."""
    if not value or value <= 0 or not math.isfinite(value):
        return 1.0
    exponent = math.floor(math.log10(value))
    for step in (1, 2, 5, 10):
        bound = step * 10.0**exponent
        if bound >= value * (1 - 1e-12):
            return float(_number(bound))
    return float(_number(10.0 ** (exponent + 1)))  # pragma: no cover




# -- Requirements ----------------------------------------------------------------------------------------------------


def predicate_for(task: Task, recipe: Recipe) -> str | None:
    """The compile-time predicate a task's requirements become (demand as literals), or ``None``."""
    terms = [
        f"candidate.properties.{req.limit} >= {_literal(req.value(recipe.demand))}" for req in task.require_limits
    ] + [f"candidate.properties.{name} == true" for name in task.require_features]
    return " && ".join(terms) or None






# -- One candidate ---------------------------------------------------------------------------------------------------
















# -- Sources -> candidates -------------------------------------------------------------------------------------------


def _sphere_candidates(
    ctx: _Context, task: Task, source: Source, read: SourcePricing, specs: Mapping[str, PropertySpec]
) -> list[_Candidate]:
    recipe = ctx.recipe
    meta = read.meta
    if read.pricing is None:
        code, message = read.refusal or ("sphere_pricing_invalid", "The pricing cannot be read.")
        if code not in ("sphere_syntax_unsupported", "sphere_pricing_invalid"):
            code = "sphere_pricing_invalid"
        ctx.once(code, message, source.at)
        return []
    pricing = read.pricing
    if not meta.content_hash_verified:
        ctx.once("sphere_content_hash_unverified",
                 "SPHERE's content hash of this version does not match the one computed here; the bytes match "
                 "their ETag and are used.", source.at)
    if meta.latest_version_id and meta.latest_version_id != meta.version_id:
        ctx.once("sphere_version_not_latest", "A newer version of this pricing exists in SPHERE.",
                 source.at + "/sphere/version")
    if pricing.currency != recipe.currency:
        ctx.once("sphere_currency_mismatch",
                 f"This pricing is in {pricing.currency} and the recipe in {recipe.currency}; F3 converts no currency.",
                 source.at)
        return []
    billing = source.billing or recipe.billing
    if billing not in {b.id for b in pricing.billing}:
        declared = ", ".join(b.id for b in pricing.billing)
        ctx.once("sphere_billing_unknown", f"This pricing declares no billing period {billing!r} (it has {declared}).",
                 source.at + ("/billing" if source.billing else ""))
        return []
    service = task.service
    resource = ids.catalog_resource(service)
    uses_price = any(spec.kind == "price" for spec in specs.values())
    named_plans = source.plans is not None
    for index, name in enumerate(source.plans or ()):
        if name not in pricing.plans:
            ctx.add(diagnostic("sphere_plan_unknown", f"This pricing has no plan {name!r}.",
                               pointer_join(source.at, "plans", index)))
    named_addons: list[str] | None = None
    if source.addons is not None:
        named_addons = []
        for index, name in enumerate(source.addons):
            add_on = pricing.add_ons.get(name)
            if add_on is None:
                ctx.add(diagnostic("sphere_addon_unknown", f"This pricing has no add-on {name!r}.",
                                   pointer_join(source.at, "addons", index)))
            elif add_on.metered:
                ctx.add(diagnostic("sphere_addon_unknown",
                                   f"{name} is charged per use (metered); metered add-ons are not imported.",
                                   pointer_join(source.at, "addons", index)))
            else:
                named_addons.append(name)
    plans = [name for name in pricing.plans if name in (source.plans or pricing.plans)]
    out: list[_Candidate] = []
    for plan_name in plans:
        plan = pricing.plans[plan_name]
        plan_id = ids.candidate_id(service, source.provider or "", plan_name)
        plan_key = ids.candidate_key(resource, plan_id)
        if not admit_plan(ctx, pricing, plan_name, plan_key, named_plans, uses_price):
            continue
        variants: list[str | None] = [None]
        for add_name, add_on in pricing.add_ons.items():
            if add_on.metered or add_on.private or add_on.depends_on or plan_name not in add_on.available_for:
                continue
            if named_addons is not None and add_name not in named_addons:
                continue
            variants.append(add_name)
        for add_name in variants:
            identifier = ids.candidate_id(service, source.provider or "", plan_name, add_name)
            key = ids.candidate_key(resource, identifier)
            if add_name is not None and not admit_add_on(ctx, pricing, plan_name, add_name, key, uses_price):
                continue
            title = plan.display_name or plan_name
            if add_name is not None:
                title += " + " + (pricing.add_ons[add_name].display_name or add_name)
            candidate = _Candidate(
                resource=resource, id=identifier, task=task.task, capability=task.capability,
                provider=source.provider or "", plan=plan_name, add_on=add_name, source=source, meta=meta,
                name=title[:160], capabilities=[task.capability],
            )
            problem = ids.id_problem(identifier)
            if problem == "too_long":
                ctx.add(diagnostic("sphere_id_too_long", f"The id {identifier} is longer than {ids.MAX_ID} characters.",
                                   key, plan=plan_name, addOn=add_name))
                continue
            if problem is not None:
                ctx.add(diagnostic("sphere_id_collision",
                                   f"{plan_name if add_name is None else add_name} has no letters or digits to make "
                                   "an id from.", key, plan=plan_name, addOn=add_name))
                continue
            if judge(ctx, candidate, pricing, billing, specs, uses_price):
                out.append(candidate)
    if len(out) > MAX_CANDIDATES_PER_SOURCE:
        ctx.add(diagnostic(
            "sphere_too_many_candidates",
            f"This pricing gives {len(out)} candidates; at most {MAX_CANDIDATES_PER_SOURCE} come from one source. "
            "Name fewer plans or add-ons.", source.at, count=len(out),
        ))
        return []
    return out


def pointer_join(at: str, *segments: object) -> str:
    return at + pointer(*segments)




def _hand_candidate(ctx: _Context, task: Task, source: Source, specs: Mapping[str, PropertySpec]) -> _Candidate | None:
    hand = source.candidate
    assert hand is not None
    resource = ids.catalog_resource(task.service)
    candidate = _Candidate(
        resource=resource, id=hand.id, task=task.task, capability=task.capability, provider=hand.provider,
        plan=None, add_on=None, source=source, meta=None, name=hand.name, capabilities=[task.capability],
    )
    complete = True
    for target in sorted(specs):
        is_feature = target in ctx.feature_targets
        given = hand.values if is_feature else hand.properties
        if target not in given:
            ctx.add(diagnostic("sphere_property_unmapped",
                               f"The hand-made candidate gives no value for {target}.", candidate.key, target=target))
            complete = False
            continue
        value = given[target]
        if is_feature:
            candidate.features[target] = float(value)
        else:
            candidate.properties[target] = value
        candidate.origins.append(
            _origin(candidate, target, "feature" if is_feature else "property", value, "manual", {"handMade": True})
        )
    # Properties the recipe does not target are kept as written (a hand-made candidate's own facts).
    for name, value in hand.properties.items():
        if name not in candidate.properties and name not in ctx.feature_targets:
            candidate.properties[name] = value
    return candidate if complete else None


# -- Pruning ---------------------------------------------------------------------------------------------------------


def _prune(ctx: _Context, candidates: list[_Candidate], specs: Mapping[str, PropertySpec],
           eligible: Mapping[str, bool]) -> list[_Candidate]:
    directions: dict[str, str] = {}
    for target, spec in specs.items():
        if target in ctx.recipe.features:
            directions[target] = ctx.recipe.features[target].direction
        elif target in ctx.feature_targets:
            continue
        elif spec.kind == "limit":
            directions[target] = "maximize"

    def vector(c: _Candidate) -> dict[str, float] | None:
        out = {}
        for target, direction in directions.items():
            value = c.features.get(target, c.properties.get(target))
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                return None
            out[target] = value if direction == "maximize" else -value
        return out

    kept = []
    for candidate in candidates:
        mine = vector(candidate)
        dominated_by = None
        if mine is not None and eligible.get(candidate.key) and candidate.meta is not None:
            for other in candidates:
                if other is candidate or other.source is not candidate.source or not eligible.get(other.key):
                    continue
                theirs = vector(other)
                if theirs is None:
                    continue
                if all(theirs[t] >= mine[t] for t in mine) and any(theirs[t] > mine[t] for t in mine):
                    dominated_by = other
                    break
        if dominated_by is not None:
            ctx.add(diagnostic("sphere_pruned", f"Left out: {dominated_by.id} is as good or better on every value.",
                               candidate.key, dominatedBy=dominated_by.key))
            continue
        kept.append(candidate)
    return kept


# -- The package -----------------------------------------------------------------------------------------------------


@dataclass
class _Base:
    files: dict[str, bytes]
    instance: dict[str, Any]
    application_id: str
    application_path: str
    application: dict[str, Any]
    optimization_path: str | None
    optimization: dict[str, Any] | None
    catalogs: dict[str, str]


def _read_base(files: Mapping[str, bytes]) -> _Base:
    instance = _load(files, "instance.json")
    resources = instance["spec"]["resources"]
    ((application_id, application_path),) = resources["application"].items()
    optimizations = resources.get("optimization") or {}
    optimization_path = next(iter(optimizations.values()), None)
    return _Base(
        files=dict(files),
        instance=instance,
        application_id=application_id,
        application_path=application_path,
        application=_load(files, application_path),
        optimization_path=optimization_path,
        optimization=_load(files, optimization_path) if optimization_path else None,
        catalogs=dict(resources.get("candidateCatalog") or {}),
    )


def _feature_definition(recipe: Recipe, name: str, selected: bool, maximum: float) -> dict[str, Any]:
    spec = recipe.features[name]
    if spec.domain == "ratio":
        domain = {"kind": "ratio", "minimum": 0, "maximum": 1}
    else:
        domain = {"kind": "real", "minimum": 0, "maximum": nice(maximum)}
    if selected:
        aggregation: Any = "sum"
    elif spec.domain == "ratio":
        aggregation = {"sequence": "product", "parallel": "product"}
    else:
        aggregation = "sum" if spec.direction == "minimize" else "min"
    return {
        "unit": unit_of(spec.unit),
        "direction": spec.direction,
        "scope": "selectedCandidate" if selected else "invocation",
        "aggregation": aggregation,
        "domain": domain,
    }


def unit_of(unit: str) -> str:
    """A recipe unit as the package writes it: no unit is the dimensionless ``1``."""
    return unit or DIMENSIONLESS


def _requires_of(value: Any) -> Any:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        return value.get("requires")
    return None


def _type_and_predicate(requires: Any) -> tuple[str | None, str | None]:
    if isinstance(requires, str):
        return requires, None
    if isinstance(requires, Mapping):
        return requires.get("type"), requires.get("predicate")
    return None, None


def generate(
    recipe: Recipe,
    sources: Mapping[SourceKey, SourcePricing],
    base: Mapping[str, bytes] | None = None,
    previous_recipe: Recipe | None = None,
    *,
    name: str = "sphere-import",
) -> Generated:
    """The package ``recipe`` makes from ``sources`` (over ``base``), with its origins, candidates, requirement
    explanations and findings. ``files`` is empty when an error was found."""
    digest = recipe_digest(recipe)
    found_base = _read_base(base) if base is not None else None
    base_features: dict[str, Any] = dict(found_base.application["spec"].get("features") or {}) if found_base else {}
    feature_targets = set(recipe.features) | set(base_features)
    ctx = _Context(recipe, feature_targets)

    selected = {
        target for task in recipe.tasks for target, spec in task.properties.items()
        if spec.kind == "price" and target in feature_targets
    }
    for name_ in sorted(selected):
        scope = base_features.get(name_, {}).get("scope") if name_ in base_features else "selectedCandidate"
        if scope != "selectedCandidate":
            ctx.add(diagnostic("sphere_feature_conflict",
                               f"{name_} takes a price, which is paid once per selected candidate; the problem's "
                               f"feature has scope {scope!r}, not selectedCandidate.", pointer("features", name_)))
    for name_, spec in recipe.features.items():
        existing = base_features.get(name_)
        if existing is None:
            continue
        if unit_of(existing.get("unit", "")) != unit_of(spec.unit) or existing.get("direction") != spec.direction:
            ctx.add(diagnostic("sphere_feature_conflict",
                               f"The problem already has a feature {name_} with unit {existing.get('unit', '')!r} and "
                               f"direction {existing.get('direction')!r}.", pointer("features", name_)))

    # Tasks of an existing problem must exist with the recipe's capability.
    previous_predicates: dict[str, str | None] = {}
    previous_services: set[str] = set()
    if previous_recipe is not None:
        previous_predicates = {t.task: predicate_for(t, previous_recipe) for t in previous_recipe.tasks}
        previous_services = {t.service for t in previous_recipe.tasks}
    if found_base is not None:
        base_tasks = found_base.application["spec"].get("tasks") or {}
        for task in recipe.tasks:
            if task.task not in base_tasks:
                ctx.add(diagnostic("sphere_task_unknown", f"The problem has no task {task.task}.", task.at + "/task"))
                continue
            value = base_tasks[task.task]
            kind = value.get("kind", "service") if isinstance(value, Mapping) else "service"
            capability, predicate = _type_and_predicate(_requires_of(value))
            if kind != "service" or capability != task.capability:
                ctx.add(diagnostic("sphere_task_capability_conflict",
                                   f"The task {task.task} requires {capability!r}, not {task.capability!r}.",
                                   task.at + "/capability"))
            elif predicate is not None and predicate != previous_predicates.get(task.task):
                ctx.add(diagnostic("sphere_requires_conflict",
                                   f"The task {task.task} has a requirement predicate this import did not write; it is "
                                   "not overwritten.", task.at + "/require"))
        for service in sorted({t.service for t in recipe.tasks}):
            resource = ids.catalog_resource(service)
            path = ids.catalog_path(service)
            if resource in found_base.catalogs and service not in previous_services:
                ctx.add(diagnostic("sphere_resource_conflict",
                                   f"The problem already has a catalog {resource} this import did not generate.", ""))
            elif path in found_base.files and found_base.catalogs.get(resource) != path:
                ctx.add(diagnostic("sphere_resource_conflict",
                                   f"The problem already has a file {path} this import did not generate.", ""))

    # Predicates.
    predicates: dict[str, str | None] = {}
    for task in recipe.tasks:
        predicate = predicate_for(task, recipe)
        if predicate is not None and (
            len(predicate) > MAX_PREDICATE_CHARS
            or len(task.require_limits) + len(task.require_features) > MAX_PREDICATE_TERMS
        ):
            ctx.add(diagnostic("sphere_recipe_shape",
                               f"A task's requirements are at most {MAX_PREDICATE_TERMS} terms.", task.at + "/require"))
            predicate = None
        predicates[task.task] = predicate

    # Candidates.
    by_catalog: dict[str, dict[str, _Candidate]] = {}
    pairs: list[tuple[Task, _Candidate]] = []
    explanations: dict[str, list[dict[str, Any]]] = {}
    used: dict[SourceKey, SnapshotMeta] = {}
    for task in recipe.tasks:
        specs = task_specs(task)
        task_candidates: list[_Candidate] = []
        for source in task.sources:
            if source.candidate is not None:
                made = _hand_candidate(ctx, task, source, specs)
                if made is not None:
                    task_candidates.append(made)
                continue
            assert source.sphere is not None
            read = sources.get(source.sphere.key)
            if read is None:
                ctx.once("sphere_source_unreadable", "This pricing version could not be read.", source.at,
                         reason="not_found")
                continue
            used.setdefault(source.sphere.key, read.meta)
            task_candidates.extend(_sphere_candidates(ctx, task, source, read, specs))
        eligible = {}
        for candidate in task_candidates:
            terms = _explain(task, recipe, candidate.properties)
            eligible[candidate.key] = all(term["satisfied"] for term in terms)
            explanations[candidate.key] = terms
        if task.prune == "dominated":
            task_candidates = _prune(ctx, task_candidates, specs, eligible)
        if not task_candidates:
            ctx.add(diagnostic("sphere_no_candidates", f"No candidate is generated for the task {task.task}.", task.at))
        for candidate in task_candidates:
            catalog = by_catalog.setdefault(candidate.resource, {})
            existing = catalog.get(candidate.id)
            if existing is None:
                catalog[candidate.id] = candidate
            elif existing.source.sphere is not None and candidate.source.sphere is not None and (
                existing.source.sphere.key == candidate.source.sphere.key
                and existing.features == candidate.features and existing.properties == candidate.properties
            ):
                if task.capability not in existing.capabilities:
                    existing.capabilities.append(task.capability)
            else:
                ctx.add(diagnostic("sphere_id_collision",
                                   f"Two candidates have the id {candidate.id} (plan names that differ only in case "
                                   "or punctuation, or one source under two tasks with other values).", candidate.key))
                continue
            pairs.append((task, candidate))

    # Every property a predicate reads must be on every candidate that provides the capability.
    if found_base is not None:
        for task in recipe.tasks:
            needed = {req.limit for req in task.require_limits} | set(task.require_features)
            if not needed or predicates.get(task.task) is None:
                continue
            for resource, path in sorted(found_base.catalogs.items()):
                if resource.startswith(ids.CATALOG_PREFIX) and resource[len(ids.CATALOG_PREFIX):] in {
                    t.service for t in recipe.tasks
                }:
                    continue
                try:
                    catalog = _load(found_base.files, path)
                except (KeyError, ValueError):
                    continue
                for identifier, entry in sorted((catalog.get("spec", {}).get("candidates") or {}).items()):
                    provides = entry.get("provides")
                    provides = [provides] if isinstance(provides, (str, dict)) else list(provides or [])
                    types = {p if isinstance(p, str) else p.get("type") for p in provides}
                    if task.capability not in types:
                        continue
                    missing = sorted(needed - set((entry.get("properties") or {})))
                    if missing:
                        ctx.add(diagnostic(
                            "sphere_property_missing_on_candidate",
                            f"{identifier} provides {task.capability} but has no {', '.join(missing)}; add it to the "
                            "recipe as a hand-made candidate.", ids.candidate_key(resource, identifier),
                            missing=missing,
                        ))

    # Removed candidates.
    if found_base is not None:
        for service in sorted({t.service for t in recipe.tasks}):
            resource = ids.catalog_resource(service)
            path = found_base.catalogs.get(resource)
            if path is None or path not in found_base.files or service not in previous_services:
                continue
            old = set((_load(found_base.files, path).get("spec", {}).get("candidates") or {}))
            for identifier in sorted(old - set(by_catalog.get(resource, {}))):
                ctx.add(diagnostic("sphere_candidate_removed",
                                   f"{identifier} is no longer generated; a binding to it will not survive.",
                                   ids.candidate_key(resource, identifier)))

    candidates_view = [
        {
            "key": c.key, "id": c.id, "task": task.task, "provider": c.provider, "plan": c.plan,
            "addOns": [c.add_on] if c.add_on else [], "price": None if c.price is None else _number(c.price),
            "eligible": all(term["satisfied"] for term in explanations.get(c.key, [])),
            "requirements": explanations.get(c.key, []), "handMade": c.meta is None,
            "sphere": None if c.meta is None else {
                "pricingId": c.meta.pricing_id, "versionId": c.meta.version_id, "registry": c.meta.registry,
                "sphereRef": c.meta.sphere_ref, "versionLabel": c.meta.version_label,
            },
        }
        for task, c in sorted(pairs, key=lambda pair: (pair[1].key, pair[0].task))
    ]
    every = [c for catalog in by_catalog.values() for c in catalog.values()]
    origins = sorted(
        (origin for c in every for origin in c.origins),
        key=lambda o: (o["candidateKey"], o["targetKind"], o["target"]),
    )
    requirements = {key: explanations[key] for key in sorted({c.key for c in every}) if explanations.get(key)}

    # Objectives on values set by hand only.
    kinds_by_target: dict[str, set[str]] = {}
    for origin in origins:
        if origin["targetKind"] == "feature":
            kinds_by_target.setdefault(origin["target"], set()).add(origin["sourceKind"])
    files: dict[str, bytes] = {}
    if not has_errors(ctx.diagnostics):
        files = _package(ctx, recipe, found_base, by_catalog, predicates, digest, name, kinds_by_target)
        if len(files) > MAX_PACKAGE_ENTRIES or sum(len(v) for v in files.values()) > MAX_PACKAGE_BYTES:
            ctx.add(diagnostic("sphere_too_many_candidates", "The generated package is over the package limits.", ""))
            files = {}
    diagnostics = sorted(ctx.diagnostics, key=lambda d: (d.at, d.code, d.message))
    return Generated(
        files=files if not has_errors(diagnostics) else {},
        origins=origins,
        candidates=candidates_view,
        requirements=requirements,
        diagnostics=diagnostics,
        predicates=predicates,
        recipe_digest=digest,
        sources=[used[key] for key in sorted(used, key=lambda k: (k[0] or "", k[1], k[2]))],
    )


def _package(
    ctx: _Context,
    recipe: Recipe,
    base: _Base | None,
    by_catalog: Mapping[str, Mapping[str, _Candidate]],
    predicates: Mapping[str, str | None],
    digest: str,
    name: str,
    kinds_by_target: Mapping[str, set[str]],
) -> dict[str, bytes]:
    maxima: dict[str, float] = {}
    for catalog in by_catalog.values():
        for candidate in catalog.values():
            for target, value in candidate.features.items():
                maxima[target] = max(maxima.get(target, 0.0), value)
    selected = {
        target for task in recipe.tasks for target, spec in task.properties.items()
        if spec.kind == "price" and target in ctx.feature_targets
    }
    if base is None:
        files: dict[str, bytes] = {}
        application_id = "application"
        application = {
            "apiVersion": QOS,
            "kind": "Application",
            "metadata": {"name": f"{name}-application"},
            "spec": {
                "tasks": {},
                "features": {
                    feature: _feature_definition(recipe, feature, feature in selected, maxima.get(feature, 0.0))
                    for feature in recipe.features
                },
                "workflow": {"sequence": [{"task": {"resource": application_id, "id": t.task}} for t in recipe.tasks]},
            },
        }
        instance = {
            "apiVersion": "bim/v1",
            "kind": "Instance",
            "metadata": {"name": name, "annotations": {RECIPE_ANNOTATION: digest}},
            "spec": {
                "profile": QOS,
                "resources": {
                    "application": {application_id: "application.json"},
                    "candidateCatalog": {},
                    "optimization": {"optimization": "optimization.json"},
                },
            },
        }
        criteria = []
        for feature, spec in recipe.features.items():
            top = 1 if spec.domain == "ratio" else nice(maxima.get(feature, 0.0))
            criteria.append({
                "id": feature, "feature": {"resource": application_id, "id": feature},
                "normalize": {"min": 0, "max": top, "clamp": True},
            })
        optimization = {
            "apiVersion": QOS, "kind": "Optimization", "metadata": {"name": f"{name}-optimization"},
            "spec": {"criteria": criteria},
        }
        application_path = "application.json"
        optimization_path: str | None = "optimization.json"
    else:
        files = dict(base.files)
        application_id = base.application_id
        application = json.loads(json.dumps(base.application))
        instance = json.loads(json.dumps(base.instance))
        metadata = instance.setdefault("metadata", {})
        annotations = metadata.get("annotations")
        if not isinstance(annotations, dict):
            annotations = {}
        annotations[RECIPE_ANNOTATION] = digest
        metadata["annotations"] = annotations
        optimization = json.loads(json.dumps(base.optimization)) if base.optimization is not None else None
        application_path = base.application_path
        optimization_path = base.optimization_path
        features = application["spec"].setdefault("features", {})
        for feature in recipe.features:
            if feature not in features:
                features[feature] = _feature_definition(recipe, feature, feature in selected, maxima.get(feature, 0.0))
        rescaled: set[str] = set()
        for feature, top in sorted(maxima.items()):
            definition = features.get(feature)
            if not isinstance(definition, dict):
                continue
            domain = definition.get("domain")
            if isinstance(domain, dict) and domain.get("kind") != "ratio":
                maximum = domain.get("maximum")
                if isinstance(maximum, (int, float)) and top > maximum:
                    domain["maximum"] = nice(top)
                    rescaled.add(feature)
            for criterion in (optimization or {}).get("spec", {}).get("criteria", []):
                if (criterion.get("feature") or {}).get("id") != feature:
                    continue
                normalize = criterion.get("normalize")
                if isinstance(normalize, dict) and isinstance(normalize.get("max"), (int, float)) and top > normalize["max"]:
                    if not (isinstance(domain, dict) and domain.get("kind") == "ratio"):
                        normalize["max"] = nice(top)
                        rescaled.add(feature)
        for feature in sorted(rescaled):
            ctx.add(diagnostic("sphere_rescaled",
                               f"The values of {feature} go past its bounds; its domain and normalisation now reach "
                               f"{_literal(nice(maxima[feature]))}.",
                               pointer("features", feature) if feature in recipe.features else "", feature=feature))
        for service in {t.service for t in recipe.tasks}:
            files.pop(ids.catalog_path(service), None)

    # Tasks and their predicates.
    tasks = application["spec"].setdefault("tasks", {})
    for task in recipe.tasks:
        predicate = predicates.get(task.task)
        current = tasks.get(task.task)
        requires: Any = {"type": task.capability, "predicate": predicate} if predicate else task.capability
        if isinstance(current, dict):
            current["requires"] = requires
        elif predicate:
            tasks[task.task] = {"requires": requires}
        else:
            tasks[task.task] = task.capability

    # Catalogs.
    catalogs = instance["spec"]["resources"].setdefault("candidateCatalog", {})
    for resource, catalog in sorted(by_catalog.items()):
        bound: set[str] = set()
        candidates_doc: dict[str, Any] = {}
        providers: dict[str, Any] = {}
        for identifier, candidate in sorted(catalog.items()):
            entry: dict[str, Any] = {
                "provides": candidate.capabilities[0] if len(candidate.capabilities) == 1 else sorted(candidate.capabilities),
                "provider": {"resource": resource, "id": candidate.provider},
                "features": {k: _number(v) for k, v in sorted(candidate.features.items())},
            }
            if candidate.properties:
                entry["properties"] = {k: _plain(v) for k, v in sorted(candidate.properties.items())}
            if candidate.name:
                entry["name"] = candidate.name
            candidates_doc[identifier] = entry
            bound |= set(candidate.features)
            providers.setdefault(candidate.provider, {})
        document = {
            "apiVersion": QOS,
            "kind": "CandidateCatalog",
            "metadata": {"name": resource},
            "spec": {
                "candidates": candidates_doc,
                "providers": providers,
                "featureBindings": {f: {"resource": application_id, "id": f} for f in sorted(bound)},
            },
        }
        path = f"{resource}.json"
        catalogs[resource] = path
        files[path] = dump(document)

    for feature, kinds in sorted(kinds_by_target.items()):
        criteria = (optimization or {}).get("spec", {}).get("criteria", [])
        if kinds == {"manual"} and any((c.get("feature") or {}).get("id") == feature for c in criteria):
            ctx.add(diagnostic("sphere_objective_manual_only",
                               f"Every generated value of the objective {feature} was set by hand; no pricing gives it.",
                               pointer("features", feature) if feature in recipe.features else "", feature=feature))

    files["instance.json"] = dump(instance)
    files[application_path] = dump(application)
    if optimization is not None and optimization_path is not None:
        files[optimization_path] = dump(optimization)
    return files
