"""The immutable Pricing2Yaml release behind contract decisions.

SPHERE owns the bytes and SPACE owns contracts. The gateway parses an exact
release only to validate administrative choices. OpenBinding operations use
the canonical feature and limit identifiers declared by that release directly;
renaming one is therefore an intentional API/contract change. Parsed objects
are cached by verified digest; YAML is never persisted here.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .core.settings import Settings
from .db.models import PricingRelease
from .sphere_client import SphereClient, SphereError

IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,127}$")


class PricingCatalogError(ValueError):
    """The selected release or subscription configuration is invalid."""


def _mapping(value: object, path: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise PricingCatalogError(f"{path} must be an object with string keys")
    return value


def _identifier(value: object, path: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise PricingCatalogError(f"{path} is not a valid identifier")
    return value


def _number(value: object, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PricingCatalogError(f"{path} must be numeric")
    result = float(value)
    if result < 0 or math.isnan(result):
        raise PricingCatalogError(f"{path} must be non-negative")
    return result


def _configured_values(
    declarations: dict[str, Any], overrides: object, path: str
) -> dict[str, Any]:
    result = {
        name: _mapping(declaration, f"{path}.{name}").get("defaultValue")
        for name, declaration in declarations.items()
    }
    for name, raw in _mapping(overrides or {}, path).items():
        if name not in declarations:
            raise PricingCatalogError(f"{path}.{name} is not declared")
        item = _mapping(raw, f"{path}.{name}")
        if "value" not in item:
            raise PricingCatalogError(f"{path}.{name}.value is required")
        result[name] = item["value"]
    return result


def _override_values(
    declarations: dict[str, Any], overrides: object, path: str
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, raw in _mapping(overrides or {}, path).items():
        if name not in declarations:
            raise PricingCatalogError(f"{path}.{name} is not declared")
        item = _mapping(raw, f"{path}.{name}")
        if "value" not in item:
            raise PricingCatalogError(f"{path}.{name}.value is required")
        result[name] = item["value"]
    return result


def _relations(raw: object, path: str) -> dict[str, int]:
    if raw is None:
        return {}
    if isinstance(raw, list):
        if any(not isinstance(item, str) for item in raw):
            raise PricingCatalogError(f"{path} must contain add-on identifiers")
        return {item: 1 for item in raw}
    if isinstance(raw, dict):
        result: dict[str, int] = {}
        for name, quantity in raw.items():
            if (
                not isinstance(name, str)
                or isinstance(quantity, bool)
                or not isinstance(quantity, int)
                or quantity < 1
            ):
                raise PricingCatalogError(
                    f"{path} must map add-on identifiers to positive integer quantities"
                )
            result[name] = quantity
        return result
    raise PricingCatalogError(f"{path} must be an array or object")


def _json_value(value: Any) -> Any:
    """Make YAML infinities legal JSON without inventing a numeric ceiling."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _json_value(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_json_value(child) for child in value]
    return value


@dataclass(frozen=True)
class PlanDefinition:
    name: str
    description: str
    price: Any
    unit: str | None
    features: dict[str, bool]
    limits: dict[str, float]


@dataclass(frozen=True)
class AddOnDefinition:
    name: str
    description: str
    price: Any
    unit: str | None
    available_for: frozenset[str]
    minimum: int
    maximum: int
    step: int
    depends_on: dict[str, int]
    excludes: frozenset[str]
    features: dict[str, bool]
    limit_overrides: dict[str, float]
    limit_extensions: dict[str, float]


@dataclass(frozen=True)
class PricingCatalog:
    version: str
    digest: str
    plans: dict[str, PlanDefinition]
    add_ons: dict[str, AddOnDefinition]
    feature_definitions: dict[str, dict[str, Any]]
    limit_definitions: dict[str, dict[str, Any]]
    linked_limits: dict[str, frozenset[str]]
    document: dict[str, Any]

    @classmethod
    def parse(cls, content: bytes, *, expected_digest: str | None = None) -> "PricingCatalog":
        digest_value = f"sha256-{hashlib.sha256(content).hexdigest()}"
        if expected_digest is not None and digest_value != expected_digest:
            raise PricingCatalogError("The SPHERE content does not match its immutable digest")
        try:
            document = yaml.safe_load(content)
        except yaml.YAMLError as exc:
            raise PricingCatalogError(f"Invalid Pricing2Yaml: {exc}") from exc
        root = _mapping(document, "pricing")
        version = root.get("version")
        if not isinstance(version, str) or not version:
            raise PricingCatalogError("pricing.version is required")

        feature_declarations = _mapping(root.get("features"), "features")
        limit_declarations = _mapping(root.get("usageLimits"), "usageLimits")
        if not feature_declarations or not limit_declarations:
            raise PricingCatalogError("features and usageLimits must not be empty")
        for name, raw in feature_declarations.items():
            _identifier(name, f"features.{name}")
            default = _mapping(raw, f"features.{name}").get("defaultValue", False)
            if not isinstance(default, bool):
                raise PricingCatalogError(f"features.{name}.defaultValue must be boolean")
        linked: dict[str, set[str]] = {}
        for name, raw in limit_declarations.items():
            _identifier(name, f"usageLimits.{name}")
            declaration = _mapping(raw, f"usageLimits.{name}")
            _number(declaration.get("defaultValue"), f"usageLimits.{name}.defaultValue")
            linked_features = declaration.get("linkedFeatures", [])
            if not isinstance(linked_features, list):
                raise PricingCatalogError(f"usageLimits.{name}.linkedFeatures must be an array")
            for feature in linked_features:
                if not isinstance(feature, str) or feature not in feature_declarations:
                    raise PricingCatalogError(f"usageLimits.{name}.linkedFeatures is invalid")
                linked.setdefault(feature, set()).add(name)

        plans: dict[str, PlanDefinition] = {}
        for name, raw in _mapping(root.get("plans"), "plans").items():
            _identifier(name, f"plans.{name}")
            declaration = _mapping(raw, f"plans.{name}")
            features = _configured_values(
                feature_declarations, declaration.get("features"), f"plans.{name}.features"
            )
            if any(not isinstance(value, bool) for value in features.values()):
                raise PricingCatalogError(f"plans.{name}.features values must be boolean")
            limits = _configured_values(
                limit_declarations, declaration.get("usageLimits"), f"plans.{name}.usageLimits"
            )
            plans[name] = PlanDefinition(
                name=name,
                description=str(declaration.get("description", "")),
                price=declaration.get("price"),
                unit=str(declaration["unit"]) if declaration.get("unit") is not None else None,
                features={key: bool(value) for key, value in features.items()},
                limits={
                    key: _number(value, f"plans.{name}.usageLimits.{key}.value")
                    for key, value in limits.items()
                },
            )
        if not plans:
            raise PricingCatalogError("pricing.plans must not be empty")

        add_ons: dict[str, AddOnDefinition] = {}
        for name, raw in _mapping(root.get("addOns") or {}, "addOns").items():
            _identifier(name, f"addOns.{name}")
            declaration = _mapping(raw, f"addOns.{name}")
            available = declaration.get("availableFor", [])
            if not isinstance(available, list) or any(
                not isinstance(plan, str) or plan not in plans for plan in available
            ):
                raise PricingCatalogError(f"addOns.{name}.availableFor is invalid")
            constraints = _mapping(
                declaration.get("subscriptionConstraints") or {},
                f"addOns.{name}.subscriptionConstraints",
            )
            minimum = constraints.get("minQuantity", 1)
            maximum = constraints.get("maxQuantity", minimum)
            step = constraints.get("quantityStep", 1)
            if any(
                isinstance(value, bool) or not isinstance(value, int)
                for value in (minimum, maximum, step)
            ):
                raise PricingCatalogError(f"addOns.{name} quantity constraints must be integers")
            if minimum < 0 or maximum < minimum or step < 1:
                raise PricingCatalogError(f"addOns.{name} quantity constraints are inconsistent")
            features = (
                _override_values(
                    feature_declarations, declaration.get("features"), f"addOns.{name}.features"
                )
                if declaration.get("features")
                else {}
            )
            if any(not isinstance(value, bool) for value in features.values()):
                raise PricingCatalogError(f"addOns.{name}.features values must be boolean")
            overrides = (
                _override_values(
                    limit_declarations,
                    declaration.get("usageLimits"),
                    f"addOns.{name}.usageLimits",
                )
                if declaration.get("usageLimits")
                else {}
            )
            extensions = _mapping(
                declaration.get("usageLimitsExtensions") or {},
                f"addOns.{name}.usageLimitsExtensions",
            )
            limit_extensions: dict[str, float] = {}
            for limit_name, extension in extensions.items():
                if limit_name not in limit_declarations:
                    raise PricingCatalogError(f"addOns.{name} extends unknown limit {limit_name!r}")
                limit_extensions[limit_name] = _number(
                    _mapping(
                        extension, f"addOns.{name}.usageLimitsExtensions.{limit_name}"
                    ).get("value"),
                    f"addOns.{name}.usageLimitsExtensions.{limit_name}.value",
                )
            add_ons[name] = AddOnDefinition(
                name=name,
                description=str(declaration.get("description", "")),
                price=declaration.get("price"),
                unit=str(declaration["unit"]) if declaration.get("unit") is not None else None,
                available_for=frozenset(available),
                minimum=minimum,
                maximum=maximum,
                step=step,
                depends_on=_relations(
                    declaration.get("dependsOn", constraints.get("dependsOn")),
                    f"addOns.{name}.dependsOn",
                ),
                excludes=frozenset(
                    _relations(
                        declaration.get("excludes", constraints.get("excludes")),
                        f"addOns.{name}.excludes",
                    )
                ),
                features={key: bool(value) for key, value in features.items()},
                limit_overrides={
                    key: _number(value, f"addOns.{name}.usageLimits.{key}.value")
                    for key, value in overrides.items()
                },
                limit_extensions=limit_extensions,
            )
        for add_on in add_ons.values():
            unknown = (set(add_on.depends_on) | set(add_on.excludes)) - set(add_ons)
            if unknown:
                raise PricingCatalogError(
                    f"addOns.{add_on.name} references unknown add-ons: "
                    + ", ".join(sorted(unknown))
                )

        return cls(
            version=version,
            digest=digest_value,
            plans=plans,
            add_ons=add_ons,
            feature_definitions={
                name: dict(_mapping(value, f"features.{name}"))
                for name, value in feature_declarations.items()
            },
            limit_definitions={
                name: dict(_mapping(value, f"usageLimits.{name}"))
                for name, value in limit_declarations.items()
            },
            linked_limits={key: frozenset(value) for key, value in linked.items()},
            document=dict(root),
        )

    @property
    def default_plan(self) -> str:
        """Return the one non-institutional free plan declared by iPricing."""
        free = [
            name
            for name, plan in self.plans.items()
            if name != "RESEARCH"
            and isinstance(plan.price, (int, float))
            and not isinstance(plan.price, bool)
            and float(plan.price) == 0
        ]
        if len(free) != 1:
            raise PricingCatalogError(
                "The active iPricing must declare exactly one non-RESEARCH zero-price default plan"
            )
        return free[0]

    def normalize_selection(self, add_ons: dict[str, int]) -> dict[str, int]:
        normalized: dict[str, int] = {}
        for name, quantity in add_ons.items():
            if not isinstance(name, str) or not IDENTIFIER.fullmatch(name):
                raise PricingCatalogError(f"Invalid add-on identifier {name!r}")
            if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 0:
                raise PricingCatalogError(f"{name} quantity must be a non-negative integer")
            if quantity:
                normalized[name] = quantity
        return normalized

    def validate_selection(self, plan: str, add_ons: dict[str, int]) -> dict[str, int]:
        if plan not in self.plans:
            raise PricingCatalogError(f"Unknown plan {plan!r} in pricing {self.version}")
        selected = self.normalize_selection(add_ons)
        for name, quantity in selected.items():
            add_on = self.add_ons.get(name)
            if add_on is None:
                raise PricingCatalogError(f"Unknown add-on {name!r} in pricing {self.version}")
            if plan not in add_on.available_for:
                raise PricingCatalogError(f"{name} is not available for {plan}")
            if (
                quantity < add_on.minimum
                or quantity > add_on.maximum
                or (quantity - add_on.minimum) % add_on.step
            ):
                raise PricingCatalogError(
                    f"{name} quantity must be {add_on.minimum}..{add_on.maximum} "
                    f"in steps of {add_on.step}"
                )
        for name in selected:
            add_on = self.add_ons[name]
            for dependency, minimum in add_on.depends_on.items():
                if selected.get(dependency, 0) < minimum:
                    raise PricingCatalogError(f"{name} depends on {dependency} quantity {minimum}")
            conflicts = add_on.excludes & set(selected)
            if conflicts:
                raise PricingCatalogError(f"{name} excludes {', '.join(sorted(conflicts))}")
        return selected

    def entitlements(
        self, plan: str, add_ons: dict[str, int] | None = None
    ) -> tuple[dict[str, bool], dict[str, float]]:
        selected = self.validate_selection(plan, dict(add_ons or {}))
        definition = self.plans[plan]
        features = dict(definition.features)
        limits = dict(definition.limits)
        for name, quantity in selected.items():
            add_on = self.add_ons[name]
            features.update(add_on.features)
            limits.update(add_on.limit_overrides)
            for limit_name, increment in add_on.limit_extensions.items():
                limits[limit_name] = limits.get(limit_name, 0) + increment * quantity
        return features, limits

    def public_view(self) -> dict[str, Any]:
        """Return the active Pricing2Yaml document, without a parallel projection."""
        return _json_value(self.document)

    def technical_errors(self, settings: Settings) -> list[str]:
        """Reject commercial promises the configured process cannot honour."""
        errors: list[str] = []
        ceilings = {
            "maxPayloadBytes": (settings.technical_max_payload_bytes, "bytes"),
            "maxTimeoutSeconds": (settings.engine_solve_timeout_s, "seconds"),
        }
        for plan_id, plan in self.plans.items():
            for identifier, (ceiling, unit) in ceilings.items():
                value = plan.limits.get(identifier)
                if value is not None and value > ceiling:
                    errors.append(
                        f"plans.{plan_id}.usageLimits.{identifier} exceeds the configured "
                        f"technical ceiling of {ceiling} {unit}."
                    )
        return errors


_REMOTE_CACHE: dict[str, PricingCatalog] = {}


async def catalog_for_version(
    session: AsyncSession,
    settings: Settings,
    version: str,
    *,
    injected: PricingCatalog | None = None,
) -> PricingCatalog:
    """Load an exact release from SPHERE, caching only by verified digest."""
    if injected is not None and injected.version == version:
        return injected
    release = await session.scalar(
        select(PricingRelease).where(PricingRelease.version == version).limit(1)
    )
    if release is None:
        raise PricingCatalogError(f"Pricing release {version!r} is not registered")
    cached = _REMOTE_CACHE.get(release.digest)
    if cached is not None:
        if errors := cached.technical_errors(settings):
            raise PricingCatalogError(" ".join(errors))
        return cached
    client = SphereClient(settings)
    try:
        content = await client.content(version)
    except SphereError as exc:
        raise PricingCatalogError(str(exc)) from exc
    finally:
        await client.aclose()
    catalog = PricingCatalog.parse(content, expected_digest=release.digest)
    if catalog.version != version:
        raise PricingCatalogError("SPHERE returned a different pricing version")
    if errors := catalog.technical_errors(settings):
        raise PricingCatalogError(" ".join(errors))
    _REMOTE_CACHE[release.digest] = catalog
    return catalog


async def live_catalog(session: AsyncSession, settings: Settings) -> PricingCatalog:
    """Resolve the LIVE release, with an explicitly injected fake for tests/dev."""
    from .space_client import get_gate

    injected = getattr(get_gate(), "catalog", None)
    version = await session.scalar(
        select(PricingRelease.version).where(PricingRelease.is_live.is_(True)).limit(1)
    )
    if version is None and isinstance(injected, PricingCatalog):
        return injected
    if version is None:
        bootstrap_version = settings.space_pricing_version
        if settings.sphere_enabled and bootstrap_version:
            client = SphereClient(settings)
            try:
                metadata = await client.exact_version(bootstrap_version)
                if metadata.private:
                    raise PricingCatalogError(
                        "The bootstrap pricing must be a public SPHERE release"
                    )
                catalog = PricingCatalog.parse(await client.content(bootstrap_version))
            except SphereError as exc:
                raise PricingCatalogError(str(exc)) from exc
            finally:
                await client.aclose()
            if catalog.version != bootstrap_version:
                raise PricingCatalogError("SPHERE returned a different bootstrap pricing version")
            if errors := catalog.technical_errors(settings):
                raise PricingCatalogError(" ".join(errors))
            _REMOTE_CACHE[catalog.digest] = catalog
            return catalog
        raise PricingCatalogError("No LIVE pricing release is registered")
    return await catalog_for_version(session, settings, str(version), injected=injected)
