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
from typing import Any, Literal, Union

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
    #: Which kind of solver the owner runs here, matched against a property's
    #: ``applies_to`` exactly as a candidate's own domain is: the one candidate this task
    #: mints carries it, so section 10.2's substitution reaches a fixed task too.
    domain: Applicability = "all"


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
    """One organization that offers candidates.

    Both fields are digest-visible, and leaving them unwritten is what moved the digest of
    ``examples/demo/16_json_complete``. So are a task's, a feature's and a candidate's name
    -- each of the four moves the IR digest, measured, and the container has a slot for
    every one. The reason this model writes a provider's and a task's and not the other two
    is the corpus, not the container: of its 82 packages, 2 carry a provider name and 18
    carry a task name, while none carries a feature name or a candidate name, so there is
    no value to write and writing one would move a digest that has none.
    """

    #: Becomes the catalog entry's ``name``.
    title: str | None = None
    #: The container's own free-form map on a provider, scalars rather than feature values:
    #: ``{"tier": "edge", "region": "eu-south"}``.
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Candidate:
    """One row of the candidate catalog.

    Values are scalars. Intervals are legal in the container and are refused here: they
    validate, compile and digest, and then fail at dispatch, because every bundled engine
    mode accepts scalar feature values only.
    """

    id: str
    #: One capability type, or several. The container accepts a list, and the list is
    #: visible in the IR **in its order and its multiplicity** -- reversing it or
    #: duplicating an entry moves the digest -- so this is a tuple and never a set, and the
    #: emitter never sorts it. Section 11's enumeration of digest-visible lists omits this
    #: one. Twelve candidates in five packages use the plural form. An earlier version of
    #: this comment said one, because it was measured over the gate of 75 while it was
    #: written about the tree of 82: four of those five packages declare a Placement
    #: resource and were outside the gate at the time. ``14_shared_candidates``'s
    #: ``shared`` is the one that is not a placement package. It reads
    #: ``scope: selectedCandidate`` too, as do all five of these and seven of the 82 in
    #: all: one candidate serving three tasks is what "shared candidates" means.
    provides: str | tuple[str, ...]
    properties: dict[str, float]
    provider: str | None = None
    #: Studio-side. A candidate's name has no home in the emitted catalog: writing
    #: ``spec.candidates.<id>.name`` moves the IR digest and no gate package carries one.
    title: str | None = None
    #: The container's own free-form ``properties`` map, which is **not** the numeric map
    #: this model calls ``properties``: that one is the container's ``features``, the
    #: values a criterion or a constraint reads. This is the descriptive one, and dropping
    #: it lost ``examples/placement/02_stock_market_sample`` forty-four recorded values.
    attributes: dict[str, Any] = field(default_factory=dict)
    #: Where this candidate runs, when the composition places its candidates at all. One
    #: pool, never a list: the IR keys a demand by candidate reference, so a second demand
    #: for one candidate last-wins silently.
    placement: PoolDemand | None = None
    #: Which kind of solver this candidate is, which is what a property's ``applies_to``
    #: is matched against. It is a Studio concept with no counterpart in the container: it
    #: decides where section 10.2's neutral is substituted, and the substitution is
    #: recorded in provenance beside the package. Every candidate in the corpus is ``all``,
    #: which is why adding this field moves no digest.
    domain: Applicability = "all"


@dataclass(frozen=True, slots=True)
class Rule:
    """A policy assertion; becomes one constraint."""

    id: str
    assertion: str
    enforcement: Literal["hard", "soft"] = "hard"
    #: What the constraint charges when it is violated, written on the constraint itself.
    penalty: float | None = None
    #: How the optimization weighs that penalty. It is a second, independent number: every
    #: soft constraint in the gate charges 1, while two packages weigh it 0.3 and three omit
    #: the key altogether -- so ``None`` means "write no weight" and is not the same as 1,
    #: and it is the default here because an omitted weight has to be expressible for those
    #: three. A soft rule that wants the usual weight states it. The penalties list is
    #: ordered in the digest, and that order is the order of ``Composition.rules``; a hard
    #: rule has no weight because it is never in that list.
    weight: float | None = None


@dataclass(frozen=True, slots=True)
class Normalize:
    """The range a criterion scales its property onto, when it is not the domain.

    A criterion's ``normalize`` is an independent number in the IR, not a projection of
    the property's domain, and the corpus uses that independence: 14 of the 82 packages
    carry a criterion range that is narrower or wider than the domain of the property it
    reads, or a range where the property declares no bounds at all. **All 14 are inside the
    phase F1 gate**, which is now the whole corpus -- the three analysis demos among them,
    the ones the Studio exists to drive -- so a goal that could only ever normalize over the
    domain would put the gate at 68 of 82 (section 11.2). Seven of the 14 declare a
    Placement resource and were outside the gate while it had exclusions, which is why an
    earlier version of this paragraph said seven were inside it.

    Widening the domain to match is not a way out: the domain is in the IR too, so moving
    it to rescue the criterion moves the digest just the same.

    ``clamp`` is not a field. Every criterion in the corpus clamps, and a criterion that
    does not is a different decision from a different range -- one this version does not
    make.
    """

    minimum: float
    maximum: float
    #: Whether a value outside the range is pulled to the nearer bound. The container's
    #: default is **false**, not true: the schema declares ``default: false`` and the
    #: compiler reads ``normalize.get("clamp", False)``, so a criterion that omits the key
    #: does not clamp. 258 criteria of the gate's 266 clamp and 8 do not -- in
    #: ``examples/demo/01_simple_seq``, ``03_xor_choice``,
    #: ``examples/placement/01_small_placement`` and one ICWS instance -- so a
    #: goal that could not say ``False`` would miss four of the gate's packages. There is no
    #: need to express the key's *absence*: the IR always carries an explicit boolean, and
    #: an omitted key and an explicit ``false`` compile to the same IR digest (measured).
    clamp: bool = True


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
class Pool:
    """One capacity pool a candidate can be placed in.

    A pool that receives no demand still has to be expressible: ``examples/placement/
    03_cloud_only``'s ``external_user_device`` takes no demand and no network edge and
    exists only as an event anchor, and dropping it is a compile error.
    """

    id: str
    capacity: dict[str, float]
    #: Free-form and **case-preserving**. The corpus spans ``generic`` -- which is the
    #: lowering's own fill-in, so an absent kind round trips as this default -- as well as
    #: ``edge``/``fog``/``cloud`` and ``EDGE``/``FOG``/``CLOUD``/``CLOUD_FAAS``/
    #: ``EXTERNAL``. Normalising the case moves the digest and is invisible in the source.
    kind: str = "generic"
    #: Digest-visible, unlike a feature's, a task's or a candidate's name, which this model
    #: drops on purpose. Only two packages carry pool names.
    name: str | None = None
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class PoolDemand:
    """What one candidate consumes in one pool.

    It lives on the candidate rather than as a list on the placement because the IR keys a
    demand by candidate reference alone: a second demand for one candidate last-wins with
    no diagnostic at all. A field makes that trap unstateable rather than merely unused.
    """

    pool: str
    resources: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class NetworkEdge:
    """One directed link between two pools."""

    source: str
    target: str
    latency: float


@dataclass(frozen=True, slots=True)
class EventLatency:
    """What one pool costs from one event's anchor."""

    pool: str
    latency: float


@dataclass(frozen=True, slots=True)
class Event:
    """A point outside the pools that the plan's latency is measured from."""

    id: str
    #: The anchor, which may be a pool nothing is assigned to.
    pool: str
    #: Ordered and digest-visible, and **not** regenerable from the pool list: one package
    #: writes its latencies in an order that is not its pools' declaration order, and
    #: another covers two of its three pools. Carried verbatim, never sorted.
    latency: tuple[EventLatency, ...] = ()


@dataclass(frozen=True, slots=True)
class Endpoint:
    """One end of a transition: a task of the application, or an event of the placement."""

    id: str
    #: Both ends are validated identically by the container, but no transition in the
    #: corpus *targets* an event, so this form is schema-faithful and uncorroborated on a
    #: target.
    event: bool = False


@dataclass(frozen=True, slots=True)
class Transition:
    """A ceiling on what moving between two points may cost.

    There is no ``enforcement`` and no ``penalty``. Every transition in the corpus lowers
    to ``hard``, which is digest-equal to writing nothing, and ``soft`` is not expressible
    here: it needs a penalty row in the Optimization keyed by a placement reference, a
    cross-document coupling no package exercises and this version does not model. The
    container refuses it by name -- "soft constraint {'resource': 'placement', ...} is not
    in Optimization" -- which is a diagnostic a reader can act on.
    """

    id: str
    source: Endpoint
    target: Endpoint
    maximum: float
    feature: str = "latency"


@dataclass(frozen=True, slots=True)
class CapacityRule:
    """Which resources are charged once per selected candidate rather than per invocation.

    Set-like on purpose: the lowering sorts and dedupes the list, so the declared order is
    invisible and storing a sequence would invent a difference the IR cannot see.
    """

    resources: frozenset[str]
    scope: Scope = "selectedCandidate"


@dataclass(frozen=True, slots=True)
class GlobalLatency:
    """How the plan's end-to-end latency is composed.

    All four members are required by the schema, so the container's own defaults are
    unreachable through a valid document -- but every package in the corpus carries
    byte-identical values, so the corpus's unanimous answer is the default here.
    """

    feature: str = "latency"
    include_execution: bool = True
    exclusive: Literal["routing", "condition"] = "routing"
    parallel: Literal["max", "sum"] = "max"


@dataclass(frozen=True, slots=True)
class Placement:
    """Where the selected candidates run, and what that costs in time and capacity.

    The container already installs ``qos-binding-placement/v1`` as a built-in dialect with
    its own resource, so nothing here is invented: this is the surface that lets a
    composition say what that dialect already understands.
    """

    pools: tuple[Pool, ...]
    #: **Post-completion and ordered**, emitted as ``networkMode: "directed"``. Measured:
    #: the completed list compiles to the same digest under either mode, because symmetric
    #: completion skips pairs already present, and directed-everywhere reproduces every
    #: placement package in the corpus. Never a set, never sorted, never a pool-pair map --
    #: both sorting it and prepending the mirrors move the digest.
    network: tuple[NetworkEdge, ...] = ()
    events: tuple[Event, ...] = ()
    #: Order is free: the lowering sorts them by reference.
    transitions: tuple[Transition, ...] = ()
    #: Ordered, because a rule's reference in the IR embeds its index.
    capacity_rules: tuple[CapacityRule, ...] = ()
    global_latency: GlobalLatency | None = None


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
    #: Where the selected candidates run. Optional, so every composition that places
    #: nothing keeps the package it had.
    placement: Placement | None = None
    #: Free-form Studio data. The translation ignores it and emits it **nowhere**: not
    #: under ``spec.extensions``, where a payload with no installed dialect and no
    #: deterministic lowering makes compilation fail, and not into the instance's
    #: annotations either, open as that map is. Keeping it out of the package entirely is
    #: what makes it inert by construction rather than inert by test, and annotations
    #: change the package digest, so two compositions differing only in a Studio tag
    #: would compile to different packages. Section 9 of the specification is the rule.
    studio: dict[str, object] = field(default_factory=dict)
