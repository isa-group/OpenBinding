"""The Composition2Yaml document, as data.

A composition is the central entity of the Studio: a name, a version, properties, tasks,
a workflow, candidates, rules and goals. This module is the in-memory shape of that
document and nothing else -- no parsing, no emission, no validation beyond what a type
can express. Both the reader and the writer of phase F1 work against it, which is what
makes "parse then serialize gives the same model" a statement worth testing.

Everything is frozen. A composition version is immutable by design: the Studio creates a
new version rather than editing one in place, and the diff between two versions is a
first-class result.

The one thing to know when reading this: Composition2Yaml has no semantics of its own.
The meaning of every field here is its translation into ``qos-binding/v1``, which
``docs/COMPOSITION2YAML.md`` fixes rule by rule.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal, Union

Direction = Literal["minimize", "maximize"]
Scope = Literal["invocation", "selectedCandidate"]
DomainKind = Literal["real", "integer", "ratio"]
#: Which candidates a property is meaningful for. A Studio concept with no counterpart in
#: the container: it drives the explicit neutral written for a candidate the property does
#: not apply to, and it is recorded in provenance.
Applicability = Literal["all", "classical", "quantum"]


@dataclass(frozen=True, slots=True)
class Domain:
    """The numeric range a property's values live in.

    The bounds are not decoration. A property whose sequence operator is ``min`` or
    ``max`` takes its neutral from a bound, so omitting that bound leaves the property
    with no neutral and the document is refused.
    """

    kind: DomainKind = "real"
    minimum: float | None = None
    maximum: float | None = None


@dataclass(frozen=True, slots=True)
class Aggregation:
    """How a property combines across the four workflow blocks, plus selection."""

    sequence: str
    parallel: str
    exclusive: str
    repeat: str
    selection: str


#: The five authoring templates of ``docs/FEATURES.md``. A template fixes direction, scope
#: and aggregation; anything declared beside it overrides it. ``cost``, ``availability``,
#: ``reliability`` and ``throughput`` coincide with the container's own shorthands, so
#: they are emitted as a shorthand string; ``latency`` differs in its parallel operator
#: and is emitted as a block policy. Both lower to the same IR.
TEMPLATES: dict[str, tuple[Direction, Aggregation]] = {
    "cost": ("minimize", Aggregation("sum", "sum", "weightedSum", "scale", "sum")),
    "latency": ("minimize", Aggregation("sum", "max", "weightedSum", "scale", "sum")),
    "availability": (
        "maximize",
        Aggregation("product", "product", "weightedProduct", "power", "product"),
    ),
    "reliability": (
        "maximize",
        Aggregation("product", "product", "weightedProduct", "power", "product"),
    ),
    "throughput": ("maximize", Aggregation("min", "min", "min", "identity", "min")),
}

#: The template whose domain is a ratio and therefore needs no explicit bounds.
RATIO_TEMPLATES = frozenset({"availability", "reliability"})


@dataclass(frozen=True, slots=True)
class Property:
    """One numeric quality of the composition; becomes one application feature."""

    unit: str
    direction: Direction
    aggregation: Aggregation
    domain: Domain
    scope: Scope = "invocation"
    title: str | None = None
    applies_to: Applicability = "all"
    #: An author-declared neutral. Left unset, it is computed from the sequence operator
    #: and the domain, and written explicitly either way.
    neutral: float | None = None


@dataclass(frozen=True, slots=True)
class OpenTask:
    """A task many candidates compete for, matched by capability."""

    requires: str
    title: str | None = None


@dataclass(frozen=True, slots=True)
class FixedTask:
    """A task with exactly one candidate, which the Studio mints a capability for."""

    properties: dict[str, float]
    title: str | None = None
    provider: str | None = None


@dataclass(frozen=True, slots=True)
class LocalTask:
    """A task that never binds and contributes each property's neutral.

    The container's own ``kind: local``. It exists here because the guiding case needs
    it: version 1 of the fleet case models its in-house classical solver this way,
    deliberately outside the candidate market.
    """

    title: str | None = None


Task = Union[OpenTask, FixedTask, LocalTask]


@dataclass(frozen=True, slots=True)
class TaskNode:
    """A workflow leaf that invokes a task."""

    task: str


@dataclass(frozen=True, slots=True)
class EmptyNode:
    """A workflow leaf that does nothing and contributes neutrals."""


@dataclass(frozen=True, slots=True)
class Sequence:
    children: tuple["Node", ...]


@dataclass(frozen=True, slots=True)
class Parallel:
    children: tuple["Node", ...]


@dataclass(frozen=True, slots=True)
class Branch:
    """One arm of an exclusive choice.

    The probability is a ``Decimal`` taken from the source text, never a float: the
    container compares the sum of a choice's probabilities against one with no tolerance,
    so the arithmetic has to be exact.
    """

    flow: "Node"
    probability: Decimal | None = None
    #: An explicit override of the derived ``<exclusive id>_branch_<n>``. Overriding must
    #: stay possible: it is the only way to reproduce an existing package whose branch ids
    #: follow no scheme, and branch ids are visible in the IR digest.
    id: str | None = None
    #: Why this branch is taken, in prose. Studio-side: never compiled, and never the
    #: container's ``when``, which this version does not emit. A condition and a
    #: probability on the same branch are not in conflict.
    condition: str | None = None


@dataclass(frozen=True, slots=True)
class Exclusive:
    """A probabilistic choice, which compiles into two documents.

    The branches land in the application workflow without conditions, and the
    probabilities land in a routing overlay that targets the branch ids. The id is
    author-given because the derived branch ids are visible in the IR digest.

    A distribution is a scenario, not a structure, which is why it lives in the overlay:
    a sweep over load mixes holds the structure fixed, and a probability inside the
    application would make every point of that sweep a different IR. The inline values are
    the composition's default; a binding scenario may override them by branch label.
    """

    id: str
    branches: tuple[Branch, ...]
    #: ``uniform`` emits ``{"uniform": true}`` and is the only way to say "equally
    #: likely": for three branches no decimal literal is exactly one third, so computed
    #: shares would fail the container's exact comparison against one. Mutually exclusive
    #: with inline probabilities.
    distribution: Literal["uniform"] | None = None


@dataclass(frozen=True, slots=True)
class Repeat:
    """A repeated block: an exact count, or a deterministic mean, never both."""

    body: "Node"
    count: int | None = None
    expected: float | None = None


Node = Union[TaskNode, EmptyNode, Sequence, Parallel, Exclusive, Repeat]


@dataclass(frozen=True, slots=True)
class Provider:
    title: str | None = None


@dataclass(frozen=True, slots=True)
class Candidate:
    """One row of the candidate catalog.

    Values are scalars. Intervals are legal in the container and are refused here: they
    validate, compile and digest, and then fail at dispatch, because every bundled engine
    mode accepts scalar feature values only.
    """

    id: str
    provides: str
    properties: dict[str, float]
    provider: str | None = None
    title: str | None = None


@dataclass(frozen=True, slots=True)
class Rule:
    """A policy assertion; becomes one constraint."""

    id: str
    assertion: str
    enforcement: Literal["hard", "soft"] = "hard"
    penalty: float | None = None


@dataclass(frozen=True, slots=True)
class Normalize:
    """The range a criterion scales its property onto, when it is not the domain.

    A criterion's ``normalize`` is an independent number in the IR, not a projection of
    the property's domain, and the corpus uses that independence: 14 of the 83 packages
    carry a criterion range that is narrower or wider than the domain of the property it
    reads, or a range where the property declares no bounds at all. Seven of those 14 are
    inside the phase F1 gate -- the three analysis demos among them, the ones the Studio
    exists to drive -- so a goal that could only ever normalize over the domain would put
    the gate at 68 of 82 instead of 75 (section 11.2).

    Widening the domain to match is not a way out: the domain is in the IR too, so moving
    it to rescue the criterion moves the digest just the same.

    ``clamp`` is not a field. Every criterion in the corpus clamps, and a criterion that
    does not is a different decision from a different range -- one this version does not
    make.
    """

    minimum: float
    maximum: float


@dataclass(frozen=True, slots=True)
class Goal:
    """One optimization criterion, naming a property.

    No weight and no scalarization: those are parameters of an analysis run, not of the
    composition. A composition that fixed them would conflate the structure with one
    study of it.

    The criterion's id is not a field either: it is the property name. The container
    requires an id and reads it from the source, so it is digest-visible and cannot be
    invented freely -- but no criterion in the corpus names anything other than the
    feature it reads, so deriving it removes a field instead of losing a capability.
    """

    property: str
    #: Left unset, the criterion normalizes over the property's domain, which is what
    #: every goal written from scratch wants. Set, it overrides that range and nothing
    #: else.
    normalize: Normalize | None = None


@dataclass(frozen=True, slots=True)
class PricingRef:
    """A permanent link to one immutable SPHERE pricing version.

    The link names the version, so there is no separate version field: a second source of
    truth for the same fact can only disagree with the first. The organization, the slug
    and the version are parsed out of the link, and the pricing's version history is
    reached by asking SPHERE for that organization and slug.

    ``digest`` is optional and is what makes the reference tamper-evident. SPHERE's
    published versions are immutable, so a changed digest is an error rather than a new
    version -- which is how the gateway already treats them.
    """

    href: str
    digest: str | None = None


@dataclass(frozen=True, slots=True)
class Composition:
    """One version of one composition: the central entity of the Studio."""

    composition: str
    version: str
    properties: dict[str, Property]
    tasks: dict[str, Task]
    workflow: Node
    title: str | None = None
    description: str | None = None
    pricing: PricingRef | None = None
    providers: dict[str, Provider] = field(default_factory=dict)
    candidates: tuple[Candidate, ...] = ()
    rules: tuple[Rule, ...] = ()
    goals: tuple[Goal, ...] = ()
    #: Free-form Studio data. The translation ignores it and emits it **nowhere**: not
    #: under ``spec.extensions``, where a payload with no installed dialect and no
    #: deterministic lowering makes compilation fail, and not into the instance's
    #: annotations either, open as that map is. Keeping it out of the package entirely is
    #: what makes it inert by construction rather than inert by test, and annotations
    #: change the package digest, so two compositions differing only in a Studio tag
    #: would compile to different packages. Section 9 of the specification is the rule.
    studio: dict[str, object] = field(default_factory=dict)
