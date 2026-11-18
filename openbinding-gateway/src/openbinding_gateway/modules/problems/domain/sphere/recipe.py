"""The SPHERE import recipe: what a generated revision is made from, validated, canonical and pinned.

A recipe is JSON the wizard builds and the gateway validates (``resources/sphere-recipe/1/recipe.schema.json``
describes the same shape for clients). It names, per task of the problem, the SPHERE pricings (by immutable
``pricingId`` and ``versionId``) and hand-made candidates that provide the task's capability, the plans and
add-ons to take, how each problem feature or candidate property is read from a pricing (a price, a usage limit,
a feature, a guarantee through a table or a scale, a constant, or a value set by hand), and the requirements a
candidate must meet (boolean features that must be true, usage limits at least a named demand). The recipe is
stored pinned (no ``latest``) in the generated revision's provenance; its canonical form (sorted keys, no
whitespace) is digested ``sha256-<hex>``.

``parse_recipe`` answers the parsed recipe or the located ``sphere_*`` findings, never an exception. Pure: this
module imports no other module of the gateway.

Property specs (the values of a task's ``properties``):

- ``"price"``: the subscription price per month of the plan and the add-on;
- ``"limit:<name>"``, ``{"limit": <name>, "unlimitedAs": <number>}``: a usage limit (unlimited is ``1e8`` for a
  property; a feature needs an explicit ``unlimitedAs``);
- ``"feature:<name>"``: a feature's value;
- ``"guarantee:<name>"``, ``{"guarantee": <name>, "scale": <number>}``: a numeric guarantee, times the scale;
  ``{"guarantee": <name>, "map": {"true": <number>, "false": <number>}}``: a boolean guarantee through a table;
- a number: a constant;
- ``{"manual": {"<provider>.<plan>" | "<provider>" | "*": <number>}}``: set by hand, the most specific key wins.

A spec object may also hold ``"<provider>": {"manual": {...}}``: a value set by hand for that provider's
candidates instead of the spec (a provider whose pricing has no such guarantee, for instance).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any

from .diagnostics import SphereDiagnostic, diagnostic, pointer

RECIPE_VERSION = "1"
#: The largest canonical recipe, in bytes.
MAX_RECIPE_BYTES = 64 * 1024
MAX_TASKS = 16
MAX_SOURCES_PER_TASK = 8
#: Distinct ``(registry, pricing, version)`` sources of one recipe: what one request may ask of SPHERE.
MAX_DISTINCT_SOURCES = 24
#: pricing4ts's sentinel for unlimited; no demand may exceed it.
UNLIMITED_VALUE = 1e8

SPHERE_ID = re.compile(r"^[0-9a-f]{24}$")
#: Task, feature, property and candidate ids: the container's own pattern for a map key.
SYMBOL = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,127}$")
#: A property a requirement reads: a name an expression path can hold (``candidate.properties.<name>``).
PREDICATE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
#: A provider key, written as one segment of a candidate id.
PROVIDER = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
#: A capability type (``service/email``).
CAPABILITY = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_.-]+){0,7}$")
CURRENCY = re.compile(r"^[A-Z]{3}$")
ALIAS = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
#: A plan, add-on, limit, feature or billing name of a pricing: printable, at most 128 characters.
NAME = re.compile(r"^[^\x00-\x1f\x7f-\x9f]{1,128}$")
LATEST = "latest"

SPEC_KEYWORDS = frozenset({"guarantee", "map", "scale", "limit", "unlimitedAs", "feature", "manual"})
DIRECTIONS = ("minimize", "maximize")
DOMAINS = ("real", "ratio")


# -- The parsed recipe ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Demand:
    name: str
    value: float
    unit: str


@dataclass(frozen=True)
class FeatureSpec:
    name: str
    unit: str
    direction: str
    domain: str = "real"


@dataclass(frozen=True)
class SphereRef:
    pricing: str
    version: str
    registry: str | None = None

    @property
    def key(self) -> tuple[str | None, str, str]:
        return (self.registry, self.pricing, self.version)

    @property
    def pinned(self) -> bool:
        return self.version != LATEST


@dataclass(frozen=True)
class HandCandidate:
    id: str
    provider: str
    name: str | None
    properties: Mapping[str, Any]
    values: Mapping[str, float]


@dataclass(frozen=True)
class Source:
    """One ``from`` entry: a SPHERE pricing (``sphere``) or a hand-made candidate (``candidate``)."""

    at: str
    sphere: SphereRef | None = None
    candidate: HandCandidate | None = None
    provider: str | None = None
    #: The raw plan names to take; ``None`` takes every plan.
    plans: tuple[str, ...] | None = None
    #: The raw add-on names whose single variants to take; ``None`` takes every subscription add-on.
    addons: tuple[str, ...] | None = None
    seats: int | None = None
    #: A recipe name -> this pricing's name (limits, features and guarantees).
    names: Mapping[str, str] = field(default_factory=dict)
    #: A required limit this pricing does not declare -> the value to assume (``"unlimited"`` or a number).
    assume: Mapping[str, float | str] = field(default_factory=dict)
    billing: str | None = None

    def name_of(self, name: str) -> str:
        return self.names.get(name, name)


@dataclass(frozen=True)
class PropertySpec:
    """How one target is read: ``kind`` is ``price``, ``limit``, ``feature``, ``guarantee``, ``constant`` or
    ``manual``; ``overrides`` are per-provider manual values."""

    kind: str
    name: str | None = None
    scale: float | None = None
    map: Mapping[str, float] | None = None
    unlimited_as: float | None = None
    value: float | None = None
    manual: Mapping[str, float] | None = None
    overrides: Mapping[str, Mapping[str, float]] = field(default_factory=dict)


@dataclass(frozen=True)
class LimitRequirement:
    limit: str
    #: A demand name, or a literal number.
    at_least: str | float

    def value(self, demand: Mapping[str, Demand]) -> float:
        if isinstance(self.at_least, str):
            return demand[self.at_least].value
        return float(self.at_least)


@dataclass(frozen=True)
class Task:
    at: str
    task: str
    capability: str
    service: str
    expand: str
    sources: tuple[Source, ...]
    require_features: tuple[str, ...]
    require_limits: tuple[LimitRequirement, ...]
    properties: Mapping[str, PropertySpec]
    prune: str


@dataclass(frozen=True)
class Recipe:
    document: Mapping[str, Any]
    currency: str
    billing: str
    demand: Mapping[str, Demand]
    features: Mapping[str, FeatureSpec]
    tasks: tuple[Task, ...]

    def sphere_sources(self) -> list[tuple[Task, Source]]:
        return [(task, source) for task in self.tasks for source in task.sources if source.sphere is not None]

    def distinct_sources(self) -> list[SphereRef]:
        seen: dict[tuple[str | None, str, str], SphereRef] = {}
        for _, source in self.sphere_sources():
            assert source.sphere is not None
            seen.setdefault(source.sphere.key, source.sphere)
        return list(seen.values())


# -- Canonical form -----------------------------------------------------------------------------------------


def canonical_bytes(document: Any) -> bytes:
    """Sorted keys, no whitespace, UTF-8: the same recipe always has the same bytes."""
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode(
        "utf-8"
    )


def canonical(recipe: Recipe) -> bytes:
    return canonical_bytes(recipe.document)


def recipe_digest(recipe: Recipe) -> str:
    return "sha256-" + hashlib.sha256(canonical(recipe)).hexdigest()


# -- Pinning ------------------------------------------------------------------------------------------------


def require_pinned(recipe: Recipe) -> list[SphereDiagnostic]:
    """``sphere_version_unpinned`` for every source still at ``latest`` (apply stores pinned recipes only)."""
    return [
        diagnostic(
            "sphere_version_unpinned",
            "Name the version of this pricing; a stored recipe never says latest.",
            source.at + "/sphere/version",
        )
        for _, source in recipe.sphere_sources()
        if source.sphere is not None and not source.sphere.pinned
    ]


def pinned(recipe: Recipe, resolved: Mapping[tuple[str | None, str], str]) -> Recipe:
    """The recipe with every ``latest`` replaced by the version ``resolved[(registry, pricing)]`` names."""
    document = json.loads(canonical(recipe))
    for task in document["tasks"]:
        for entry in task["from"]:
            sphere = entry.get("sphere")
            if isinstance(sphere, dict) and sphere.get("version") == LATEST:
                sphere["version"] = resolved[(sphere.get("registry"), sphere["pricing"])]
    parsed, problems = parse_recipe(document)
    assert parsed is not None and not problems, problems
    return parsed


def with_document(recipe: Recipe, document: Mapping[str, Any]) -> Recipe:
    return replace(recipe, document=document)


# -- Parsing ------------------------------------------------------------------------------------------------


class _Findings:
    def __init__(self) -> None:
        self.items: list[SphereDiagnostic] = []

    def shape(self, message: str, at: str) -> None:
        self.items.append(diagnostic("sphere_recipe_shape", message, at))

    def add(self, item: SphereDiagnostic) -> None:
        self.items.append(item)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _object(value: Any, at: str, findings: _Findings, allowed: set[str], required: set[str] = frozenset()) -> bool:
    if not isinstance(value, Mapping):
        findings.shape("This must be an object.", at)
        return False
    ok = True
    for key in value:
        if not isinstance(key, str) or key not in allowed:
            findings.shape(f"Unknown member {key!r}.", pointer_join(at, key))
            ok = False
    for key in sorted(required):
        if key not in value:
            findings.shape(f"The member {key!r} is required.", pointer_join(at, key))
            ok = False
    return ok


def pointer_join(at: str, *segments: object) -> str:
    return at + pointer(*segments)


def _symbol(value: Any, at: str, findings: _Findings, what: str = "an id") -> str | None:
    if isinstance(value, str) and SYMBOL.fullmatch(value):
        return value
    findings.shape(f"This must be {what}: a letter, then up to 127 letters, digits, '_', '.' or '-'.", at)
    return None


def _predicate_name(value: Any, at: str, findings: _Findings) -> str | None:
    if isinstance(value, str) and PREDICATE_NAME.fullmatch(value):
        return value
    findings.shape("A required name is a letter, then up to 63 letters, digits or '_' (it is read in an expression).", at)
    return None


def _name(value: Any, at: str, findings: _Findings) -> str | None:
    if isinstance(value, str) and NAME.fullmatch(value):
        return value
    findings.shape("This must be a name of the pricing: 1 to 128 printable characters.", at)
    return None


def parse_recipe(data: Any) -> tuple[Recipe | None, list[SphereDiagnostic]]:
    """The recipe, or ``None`` and the located findings (``sphere_recipe_shape`` and the recipe-level codes)."""
    findings = _Findings()
    try:
        size = len(canonical_bytes(data))
    except (TypeError, ValueError):
        findings.shape("A recipe is a JSON object.", "")
        return None, findings.items
    if size > MAX_RECIPE_BYTES:
        findings.shape(f"A recipe is at most {MAX_RECIPE_BYTES} bytes in canonical form ({size} here).", "")
        return None, findings.items
    # Read the canonical form: every object in key order, so nothing generated depends on how the JSON was written.
    data = json.loads(canonical_bytes(data))
    if not _object(data, "", findings, {"recipeVersion", "currency", "billing", "demand", "features", "tasks"},
                   {"recipeVersion", "currency", "tasks"}):
        return None, findings.items
    if data["recipeVersion"] != RECIPE_VERSION:
        findings.shape(f'This gateway reads recipe version "{RECIPE_VERSION}".', "/recipeVersion")
    currency = data["currency"]
    if not (isinstance(currency, str) and CURRENCY.fullmatch(currency)):
        findings.shape("A currency is an ISO 4217 code, such as USD.", "/currency")
    billing = data.get("billing", "monthly")
    if _name(billing, "/billing", findings) is None:
        billing = "monthly"

    demand = _demand(data.get("demand", {}), findings)
    declared = set(data["demand"]) if isinstance(data.get("demand"), Mapping) else set()
    features = _features(data.get("features", {}), findings)
    tasks: list[Task] = []
    raw_tasks = data["tasks"]
    if not isinstance(raw_tasks, list) or not raw_tasks:
        findings.shape("A recipe names at least one task.", "/tasks")
        raw_tasks = []
    elif len(raw_tasks) > MAX_TASKS:
        findings.shape(f"A recipe names at most {MAX_TASKS} tasks.", "/tasks")
        raw_tasks = []
    seen_tasks: set[str] = set()
    for index, raw in enumerate(raw_tasks):
        task = _task(raw, f"/tasks/{index}", demand, declared, findings)
        if task is None:
            continue
        if task.task in seen_tasks:
            findings.shape(f"The task {task.task!r} is named twice.", f"/tasks/{index}/task")
            continue
        seen_tasks.add(task.task)
        tasks.append(task)

    distinct = {
        source.sphere.key for task in tasks for source in task.sources if source.sphere is not None
    }
    if len(distinct) > MAX_DISTINCT_SOURCES:
        findings.shape(
            f"A recipe reads at most {MAX_DISTINCT_SOURCES} distinct pricing versions ({len(distinct)} here).", "/tasks"
        )
    if findings.items:
        return None, findings.items
    recipe = Recipe(
        document=json.loads(canonical_bytes(data)),
        currency=currency,
        billing=billing,
        demand=demand,
        features=features,
        tasks=tuple(tasks),
    )
    return recipe, []


def _demand(raw: Any, findings: _Findings) -> dict[str, Demand]:
    out: dict[str, Demand] = {}
    if not isinstance(raw, Mapping):
        findings.shape("The demand is an object of named quantities.", "/demand")
        return out
    for name, item in raw.items():
        at = pointer("demand", name)
        if _symbol(name, at, findings, "a demand name") is None:
            continue
        if not _object(item, at, findings, {"value", "unit"}, {"value"}):
            continue
        value = item["value"]
        if not _is_number(value) or value < 0:
            findings.shape("A demand is a non-negative number.", at + "/value")
            continue
        if value > UNLIMITED_VALUE:
            findings.add(diagnostic(
                "sphere_demand_too_large",
                f"A demand is at most {UNLIMITED_VALUE:.0f}, the value that stands for unlimited.", at + "/value",
            ))
            continue
        unit = item.get("unit", "")
        if not isinstance(unit, str) or len(unit) > 64:
            findings.shape("A unit is a text of at most 64 characters.", at + "/unit")
            continue
        out[name] = Demand(name, float(value), unit)
    return out


def _features(raw: Any, findings: _Findings) -> dict[str, FeatureSpec]:
    out: dict[str, FeatureSpec] = {}
    if not isinstance(raw, Mapping):
        findings.shape("The features are an object of problem features.", "/features")
        return out
    for name, item in raw.items():
        at = pointer("features", name)
        if _symbol(name, at, findings, "a feature id") is None:
            continue
        if not _object(item, at, findings, {"unit", "direction", "domain"}, {"direction"}):
            continue
        unit = item.get("unit", "")
        direction = item["direction"]
        domain = item.get("domain", "real")
        if not isinstance(unit, str) or len(unit) > 64:
            findings.shape("A unit is a text of at most 64 characters.", at + "/unit")
        elif direction not in DIRECTIONS:
            findings.shape("A direction is minimize or maximize.", at + "/direction")
        elif domain not in DOMAINS:
            findings.shape("A domain is real or ratio.", at + "/domain")
        else:
            out[name] = FeatureSpec(name, unit, direction, domain)
    return out


def _slug(text: str) -> str:
    import unicodedata

    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")


def _task(raw: Any, at: str, demand: Mapping[str, Demand], declared: set[str], findings: _Findings) -> Task | None:
    allowed = {"task", "capability", "service", "expand", "from", "require", "properties", "prune"}
    if not _object(raw, at, findings, allowed, {"task", "capability", "from"}):
        return None
    before = len(findings.items)
    task_id = _symbol(raw["task"], at + "/task", findings, "a task id")
    capability = raw["capability"]
    if not (isinstance(capability, str) and len(capability) <= 128 and CAPABILITY.fullmatch(capability)):
        findings.shape("A capability is a type such as service/email.", at + "/capability")
        capability = None
    service = raw.get("service")
    if service is None and capability is not None:
        service = _slug(capability.rsplit("/", 1)[-1])
    if not (isinstance(service, str) and PROVIDER.fullmatch(service)):
        findings.shape("A service key is 1 to 40 lowercase letters, digits and '-', starting with a letter.",
                       at + "/service")
        service = None
    expand = raw.get("expand", "plans")
    if expand == "configurations":
        findings.add(diagnostic(
            "sphere_expand_unsupported",
            "Add-on combinations (configurations) are not imported yet; expand plans instead.", at + "/expand",
        ))
    elif expand != "plans":
        findings.shape("expand is plans.", at + "/expand")
    prune = raw.get("prune", "none")
    if prune not in ("none", "dominated"):
        findings.shape("prune is none or dominated.", at + "/prune")

    require_features, require_limits = _require(raw.get("require", {}), at + "/require", demand, declared, findings)
    properties = _properties(raw.get("properties", {}), at + "/properties", findings)

    sources: list[Source] = []
    raw_sources = raw["from"]
    if not isinstance(raw_sources, list) or not raw_sources:
        findings.shape("A task takes candidates from at least one source.", at + "/from")
        raw_sources = []
    elif len(raw_sources) > MAX_SOURCES_PER_TASK:
        findings.shape(f"A task takes candidates from at most {MAX_SOURCES_PER_TASK} sources.", at + "/from")
        raw_sources = []
    required = {req.limit for req in require_limits}
    for index, item in enumerate(raw_sources):
        source = _source(item, f"{at}/from/{index}", required, findings)
        if source is not None:
            sources.append(source)
    if len(findings.items) > before or task_id is None or capability is None or service is None:
        return None
    return Task(
        at=at,
        task=task_id,
        capability=capability,
        service=service,
        expand=expand,
        sources=tuple(sources),
        require_features=require_features,
        require_limits=require_limits,
        properties=properties,
        prune=prune,
    )


def _require(
    raw: Any, at: str, demand: Mapping[str, Demand], declared: set[str], findings: _Findings
) -> tuple[tuple[str, ...], tuple[LimitRequirement, ...]]:
    if not _object(raw, at, findings, {"features", "limits"}):
        return (), ()
    features: list[str] = []
    raw_features = raw.get("features", [])
    if not isinstance(raw_features, list):
        findings.shape("Required features are a list of boolean feature names.", at + "/features")
    else:
        for index, name in enumerate(raw_features):
            if _predicate_name(name, f"{at}/features/{index}", findings) is not None:
                features.append(name)
    limits: list[LimitRequirement] = []
    raw_limits = raw.get("limits", {})
    if not isinstance(raw_limits, Mapping):
        findings.shape("Required limits are an object of limit names.", at + "/limits")
        raw_limits = {}
    for name, item in raw_limits.items():
        here = pointer_join(at, "limits", name)
        if _predicate_name(name, here, findings) is None:
            continue
        if not _object(item, here, findings, {"atLeast"}, {"atLeast"}):
            continue
        bound = item["atLeast"]
        if isinstance(bound, str):
            if bound not in demand:
                if bound not in declared:  # a declared demand that was refused is reported once, where it is
                    findings.shape(f"No demand is named {bound!r}.", here + "/atLeast")
                continue
        elif _is_number(bound) and bound >= 0:
            if bound > UNLIMITED_VALUE:
                findings.add(diagnostic(
                    "sphere_demand_too_large",
                    f"A demand is at most {UNLIMITED_VALUE:.0f}, the value that stands for unlimited.",
                    here + "/atLeast",
                ))
                continue
            bound = float(bound)
        else:
            findings.shape("atLeast names a demand or is a non-negative number.", here + "/atLeast")
            continue
        limits.append(LimitRequirement(name, bound))
    return tuple(features), tuple(limits)


def _number_map(raw: Any, at: str, findings: _Findings, keys: re.Pattern[str] | None = None) -> dict[str, float] | None:
    if not isinstance(raw, Mapping) or not raw:
        findings.shape("This is a non-empty object of numbers.", at)
        return None
    out: dict[str, float] = {}
    for key, value in raw.items():
        if keys is not None and not (isinstance(key, str) and keys.fullmatch(key)):
            findings.shape(f"{key!r} is not a key here.", pointer_join(at, key))
            return None
        if not _is_number(value):
            findings.shape("This is a number.", pointer_join(at, key))
            return None
        out[key] = float(value)
    return out


#: A manual key: ``*``, ``<provider>`` or ``<provider>.<plan>`` (the plan as the pricing names it).
_MANUAL_KEY = re.compile(r"^(?:\*|[a-z][a-z0-9-]{0,39}(?:\.[^\x00-\x1f\x7f-\x9f]{1,128})?)$")


def _properties(raw: Any, at: str, findings: _Findings) -> dict[str, PropertySpec]:
    out: dict[str, PropertySpec] = {}
    if not isinstance(raw, Mapping):
        findings.shape("The properties are an object of property specs.", at)
        return out
    for target, spec in raw.items():
        here = pointer_join(at, target)
        if _symbol(target, here, findings, "a feature or property name") is None:
            continue
        parsed = _spec(spec, here, findings)
        if parsed is not None:
            out[target] = parsed
    return out


def _spec(spec: Any, at: str, findings: _Findings) -> PropertySpec | None:
    if _is_number(spec):
        return PropertySpec("constant", value=float(spec))
    if isinstance(spec, str):
        if spec == "price":
            return PropertySpec("price")
        kind, _, name = spec.partition(":")
        if kind in ("limit", "feature", "guarantee") and name and NAME.fullmatch(name):
            return PropertySpec(kind, name=name)
        findings.shape('A spec is "price", "limit:<name>", "feature:<name>", "guarantee:<name>", a number or an object.', at)
        return None
    if not isinstance(spec, Mapping):
        findings.shape("A spec is a text, a number or an object.", at)
        return None
    overrides: dict[str, Mapping[str, float]] = {}
    for key, value in spec.items():
        if key in SPEC_KEYWORDS:
            continue
        if not (isinstance(key, str) and PROVIDER.fullmatch(key)):
            findings.shape(f"Unknown member {key!r}.", pointer_join(at, key))
            return None
        if not _object(value, pointer_join(at, key), findings, {"manual"}, {"manual"}):
            return None
        manual = _number_map(value["manual"], pointer_join(at, key, "manual"), findings, _MANUAL_KEY)
        if manual is None:
            return None
        overrides[key] = manual
    kinds = [k for k in ("guarantee", "limit", "feature", "manual") if k in spec]
    if len(kinds) != 1:
        findings.shape("A spec object names exactly one of guarantee, limit, feature or manual.", at)
        return None
    kind = kinds[0]
    if kind == "manual":
        if set(spec) & {"map", "scale", "unlimitedAs"}:
            findings.shape("A manual spec has only its values.", at)
            return None
        manual = _number_map(spec["manual"], at + "/manual", findings, _MANUAL_KEY)
        if manual is None:
            return None
        return PropertySpec("manual", manual=manual, overrides=overrides)
    name = spec[kind]
    if not (isinstance(name, str) and NAME.fullmatch(name)):
        findings.shape("This names a limit, feature or guarantee of the pricing.", pointer_join(at, kind))
        return None
    if kind == "guarantee":
        if "unlimitedAs" in spec or ("map" in spec and "scale" in spec):
            findings.shape("A guarantee takes a map (boolean) or a scale (numeric), not both.", at)
            return None
        mapping = None
        if "map" in spec:
            mapping = _number_map(spec["map"], at + "/map", findings, re.compile(r"^(?:true|false)$"))
            if mapping is None:
                return None
        scale = spec.get("scale")
        if scale is not None and (not _is_number(scale) or scale <= 0):
            findings.shape("A scale is a positive number.", at + "/scale")
            return None
        return PropertySpec("guarantee", name=name, scale=None if scale is None else float(scale), map=mapping,
                            overrides=overrides)
    if kind == "limit":
        if set(spec) & {"map", "scale"}:
            findings.shape("A limit spec takes only unlimitedAs.", at)
            return None
        unlimited_as = spec.get("unlimitedAs")
        if unlimited_as is not None and (not _is_number(unlimited_as) or unlimited_as < 0):
            findings.shape("unlimitedAs is a non-negative number.", at + "/unlimitedAs")
            return None
        return PropertySpec("limit", name=name, unlimited_as=None if unlimited_as is None else float(unlimited_as),
                            overrides=overrides)
    if set(spec) & {"map", "scale", "unlimitedAs"}:
        findings.shape("A feature spec takes only its name.", at)
        return None
    return PropertySpec("feature", name=name, overrides=overrides)


def _source(raw: Any, at: str, required_limits: set[str], findings: _Findings) -> Source | None:
    if not isinstance(raw, Mapping):
        findings.shape("A source is an object.", at)
        return None
    if "candidate" in raw:
        if not _object(raw, at, findings, {"candidate"}, {"candidate"}):
            return None
        candidate = _hand_candidate(raw["candidate"], at + "/candidate", findings)
        return None if candidate is None else Source(at=at, candidate=candidate, provider=candidate.provider)
    allowed = {"sphere", "provider", "plans", "addons", "seats", "names", "assume", "billing"}
    if not _object(raw, at, findings, allowed, {"sphere", "provider"}):
        return None
    before = len(findings.items)
    sphere = _sphere(raw["sphere"], at + "/sphere", findings)
    provider = raw["provider"]
    if not (isinstance(provider, str) and PROVIDER.fullmatch(provider)):
        findings.shape("A provider key is 1 to 40 lowercase letters, digits and '-', starting with a letter.",
                       at + "/provider")
    plans = _names(raw.get("plans"), at + "/plans", findings)
    addons = _names(raw.get("addons"), at + "/addons", findings)
    seats = raw.get("seats")
    if seats is not None and not (isinstance(seats, int) and not isinstance(seats, bool) and 1 <= seats <= 100000):
        findings.shape("Seats are a whole number from 1 to 100000.", at + "/seats")
    names: dict[str, str] = {}
    raw_names = raw.get("names", {})
    if not isinstance(raw_names, Mapping):
        findings.shape("names is an object: a recipe name -> this pricing's name.", at + "/names")
    else:
        for key, value in raw_names.items():
            if _symbol(key, pointer_join(at, "names", key), findings, "a recipe name") is None:
                continue
            if _name(value, pointer_join(at, "names", key), findings) is not None:
                names[key] = value
    assume: dict[str, float | str] = {}
    raw_assume = raw.get("assume", {})
    if not isinstance(raw_assume, Mapping):
        findings.shape("assume is an object: a required limit -> unlimited or a number.", at + "/assume")
    else:
        for key, value in raw_assume.items():
            here = pointer_join(at, "assume", key)
            if key not in required_limits:
                findings.shape(f"{key!r} is not a limit this task requires; only a required limit is assumed.", here)
            elif value == "unlimited":
                assume[key] = "unlimited"
            elif _is_number(value) and value >= 0:
                assume[key] = float(value)
            else:
                findings.shape('An assumed limit is "unlimited" or a non-negative number.', here)
    billing = raw.get("billing")
    if billing is not None:
        _name(billing, at + "/billing", findings)
    if len(findings.items) > before or sphere is None:
        return None
    return Source(
        at=at, sphere=sphere, provider=provider, plans=plans, addons=addons, seats=seats, names=names,
        assume=assume, billing=billing,
    )


def _names(raw: Any, at: str, findings: _Findings) -> tuple[str, ...] | None:
    if raw is None:
        return None
    if not isinstance(raw, list):
        findings.shape("This is a list of names of the pricing.", at)
        return None
    out: list[str] = []
    for index, item in enumerate(raw):
        name = _name(item, f"{at}/{index}", findings)
        if name is not None and name not in out:
            out.append(name)
    return tuple(out)


def _sphere(raw: Any, at: str, findings: _Findings) -> SphereRef | None:
    if not _object(raw, at, findings, {"pricing", "version", "registry"}, {"pricing", "version"}):
        return None
    pricing, version, registry = raw["pricing"], raw["version"], raw.get("registry")
    ok = True
    if not (isinstance(pricing, str) and SPHERE_ID.fullmatch(pricing)):
        findings.shape("A SPHERE pricing id is 24 lowercase hexadecimal characters.", at + "/pricing")
        ok = False
    if not (isinstance(version, str) and (version == LATEST or SPHERE_ID.fullmatch(version))):
        findings.shape("A SPHERE version id is 24 lowercase hexadecimal characters (or latest, to preview).",
                       at + "/version")
        ok = False
    if registry is not None and not (isinstance(registry, str) and ALIAS.fullmatch(registry)):
        findings.shape("A registry is an alias of SPHERE_REGISTRIES.", at + "/registry")
        ok = False
    return SphereRef(pricing, version, registry) if ok else None


def _hand_candidate(raw: Any, at: str, findings: _Findings) -> HandCandidate | None:
    if not _object(raw, at, findings, {"id", "provider", "name", "properties", "values"}, {"id", "provider"}):
        return None
    before = len(findings.items)
    identifier = _symbol(raw["id"], at + "/id", findings, "a candidate id")
    provider = raw["provider"]
    if not (isinstance(provider, str) and PROVIDER.fullmatch(provider)):
        findings.shape("A provider key is 1 to 40 lowercase letters, digits and '-', starting with a letter.",
                       at + "/provider")
    name = raw.get("name")
    if name is not None and not (isinstance(name, str) and 0 < len(name) <= 160):
        findings.shape("A name is 1 to 160 characters.", at + "/name")
    properties: dict[str, Any] = {}
    raw_properties = raw.get("properties", {})
    if not isinstance(raw_properties, Mapping):
        findings.shape("properties is an object of scalars.", at + "/properties")
    else:
        for key, value in raw_properties.items():
            here = pointer_join(at, "properties", key)
            if _symbol(key, here, findings, "a property name") is None:
                continue
            if isinstance(value, bool) or _is_number(value) or (isinstance(value, str) and len(value) <= 256):
                properties[key] = value
            else:
                findings.shape("A property is a number, a boolean or a short text.", here)
    values: dict[str, float] = {}
    raw_values = raw.get("values", {})
    if not isinstance(raw_values, Mapping):
        findings.shape("values is an object of numbers by feature.", at + "/values")
    else:
        for key, value in raw_values.items():
            here = pointer_join(at, "values", key)
            if _symbol(key, here, findings, "a feature id") is None:
                continue
            if _is_number(value):
                values[key] = float(value)
            else:
                findings.shape("A feature value is a number.", here)
    if len(findings.items) > before or identifier is None:
        return None
    return HandCandidate(identifier, provider, name, properties, values)
