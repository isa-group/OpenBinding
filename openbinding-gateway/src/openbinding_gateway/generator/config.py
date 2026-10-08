"""Public generation configuration shared by the API and both synthesizers."""

from __future__ import annotations

import math
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Distribution(StrictModel):
    kind: Literal["uniform", "normal"]
    minimum: float
    maximum: float
    mean: float | None = None
    stddev: float | None = None

    @model_validator(mode="after")
    def check(self) -> "Distribution":
        values = [v for v in (self.minimum, self.maximum, self.mean, self.stddev) if v is not None]
        if not all(math.isfinite(v) for v in values):
            raise ValueError("distribution values must be finite; provide finite bounds and parameters")
        if self.maximum < self.minimum:
            raise ValueError("maximum must be >= minimum; reverse the bounds")
        if self.kind == "normal":
            if self.mean is None or self.stddev is None or self.stddev <= 0:
                raise ValueError("normal requires mean and positive stddev")
        elif self.mean is not None or self.stddev is not None:
            raise ValueError("uniform uses only minimum and maximum; remove mean/stddev")
        return self


class Aggregation(StrictModel):
    selection: Literal["sum", "product", "min", "max"] | None = None
    sequence: Literal["sum", "product", "min", "max"] | None = None
    parallel: Literal["sum", "product", "min", "max"] | None = None
    exclusive: Literal["weightedSum", "weightedProduct", "min", "max"] | None = None
    repeat: Literal["scale", "power", "identity"] | None = None


class FeatureDefinition(StrictModel):
    id: str | None = None
    count: int = Field(default=1, ge=1, le=100)
    unit: str = Field(min_length=1)
    direction: Literal["minimize", "maximize"]
    scope: Literal["selectedCandidate", "invocation"]
    distribution: Distribution
    aggregation: Aggregation
    objective: bool = True

    @model_validator(mode="after")
    def check(self) -> "FeatureDefinition":
        if not self.unit.strip():
            raise ValueError("unit must not be blank; provide a meaningful unit")
        if self.id is not None and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,127}", self.id):
            raise ValueError("id must match [A-Za-z][A-Za-z0-9_]{0,127}; use a valid BIM feature ID")
        keys = set(self.aggregation.model_dump(exclude_none=True))
        expected = {"selection"} if self.scope == "selectedCandidate" else {"sequence", "parallel", "exclusive", "repeat"}
        if keys != expected:
            raise ValueError(f"aggregation for {self.scope} must contain exactly {sorted(expected)}")
        ops = set(self.aggregation.model_dump(exclude_none=True).values())
        if self.distribution.minimum < 0 and ops.intersection({"product", "weightedProduct", "power"}):
            raise ValueError("product and power aggregation require nonnegative feature bounds")
        return self


class GenerationDistributions(StrictModel):
    candidate_count: Distribution | None = None
    loop_iterations: Distribution | None = None
    branches_per_decision: Distribution | None = None
    constraint_optimality_percent: Distribution | None = None

    @model_validator(mode="after")
    def check(self) -> "GenerationDistributions":
        ranges = {"candidate_count": (2, 100), "loop_iterations": (1, 50),
                  "branches_per_decision": (2, 10), "constraint_optimality_percent": (0, 100)}
        for name, (low, high) in ranges.items():
            dist = getattr(self, name)
            if dist is None:
                continue
            if dist.minimum < low or dist.maximum > high:
                raise ValueError(f"{name} bounds must stay within [{low}, {high}]")
            if name != "constraint_optimality_percent" and not (dist.minimum.is_integer() and dist.maximum.is_integer()):
                raise ValueError(f"{name} bounds must be integers")
        return self


def expand_features(features: list[FeatureDefinition]) -> list[dict]:
    expanded: list[dict] = []
    used: set[str] = set()
    for feature in features:
        for item in range(feature.count):
            feature_id = (f"{feature.id}_{item + 1}" if feature.id and feature.count > 1 else
                          feature.id or f"qos_{len(expanded) + 1}")
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,127}", feature_id):
                raise ValueError(f"features: expanded id {feature_id!r} is invalid or too long; shorten id or count")
            if feature_id in used:
                raise ValueError(f"features: duplicate expanded id {feature_id!r}; rename the feature")
            used.add(feature_id)
            expanded.append({**feature.model_dump(exclude={"count", "id"}), "id": feature_id})
    if len(expanded) > 100:
        raise ValueError("features: at most 100 expanded features; reduce count")
    return expanded
