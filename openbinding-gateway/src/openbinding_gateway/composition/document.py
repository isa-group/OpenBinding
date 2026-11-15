"""The Composition2Yaml document, in memory.

A Composition2Yaml document declares a **final composition**: the candidate chosen for each
task of a workflow, where it came from, the global values it yields, and optionally the BIM
problem and compilation it was judged against, the composition's own offering and the
evidence of how its values were obtained. The space of alternatives is the BIM problem's;
none of it is written here.

Every type is a frozen, slotted dataclass. ``binding`` and ``values`` are ordered tuples, so
a document is hashable and two equal documents write the same bytes: the reader puts the
binding in the order a depth-first walk of the workflow first meets each task, and the values
in code-point order of their names, which is the order :func:`.text.document` writes them in.
Numbers stay the ``int`` or ``float`` the YAML or JSON reader produced: a value is the double
the toolchain computed, written and read back as that double.

:class:`Paths` holds where each workflow node was read from. Equality ignores it, so a
document read from flow-style text equals the same document read from its canonical form,
while a diagnostic about a node still underlines the text the author wrote.

The language is versioned like Pricing2Yaml: every document carries ``syntaxVersion``, a
quoted ``<major>.<minor>`` string checked against :data:`SUPPORTED_SYNTAX_VERSIONS`. It is
Composition2Yaml's own version and never follows the toolchain's or BIM's releases; the
document's own label is ``version``, a semver string.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Mapping

from .diagnostics import Path
from .workflow import Location, Node

#: The syntax version this library writes.
SYNTAX_VERSION = "1.0"
#: The syntax versions this library reads.
SUPPORTED_SYNTAX_VERSIONS: tuple[str, ...] = ("1.0",)

Kind = Literal["application", "workflow", "pipeline", "system"]
#: What a composition is. Metadata only: no rule depends on it.
KINDS: tuple[str, ...] = ("application", "workflow", "pipeline", "system")

#: The root keys, in the order the canonical form writes them.
ROOT_KEYS: tuple[str, ...] = (
    "syntaxVersion", "composition", "version", "kind", "problem",
    "workflow", "binding", "values", "offering", "evidence",
)
#: The root keys every document has.
REQUIRED_KEYS: tuple[str, ...] = (
    "syntaxVersion", "composition", "version", "kind", "workflow", "binding", "values",
)

#: Root keys that hold a problem's content: written in the BIM problem, never here.
PROBLEM_KEYS = frozenset({
    "tasks", "properties", "candidates", "alternatives", "constraints", "rules",
    "objectives", "goals", "services", "scenarios", "providers", "placement", "demand",
    "weights", "scalarization",
})
#: Keys of a binding entry that hold a problem's content: the alternatives to the choice.
ENTRY_PROBLEM_KEYS = frozenset({"candidates", "alternatives"})
#: Keys that would write an offering's content into the document, where only its reference goes.
OFFERING_CONTENT_KEYS = frozenset({
    "plans", "addOns", "price", "prices", "features", "usageLimits", "version", "currency", "billing",
})

#: The unit of a dimensionless value, written as a bare number.
DIMENSIONLESS = "1"


@dataclass(frozen=True, slots=True)
class ProblemRef:
    """A revision of a BIM problem: ``<organization>/problems/<problem>@<revision>``."""

    organization: str
    problem: str
    revision: str

    def __str__(self) -> str:
        return f"{self.organization}/problems/{self.problem}@{self.revision}"


@dataclass(frozen=True, slots=True)
class ProblemLink:
    """The problem a composition was judged against, and the compilation it was judged on."""

    ref: ProblemRef
    #: A ``compilation_digest``.
    compilation: str


@dataclass(frozen=True, slots=True)
class Provenance:
    """Where a chosen candidate came from: a plan of a SPHERE pricing, at a pinned version.

    Written ``from``. ``sphere``, ``version`` and ``plan`` are required by the language; they
    are optional here only so the coherence checks can say which one a document left out.
    """

    sphere: str | None
    version: str | None
    plan: str | None
    registry: str | None = None
    addons: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Entry:
    """The binding of one task: a candidate (with its provenance), or ``local: true``."""

    candidate: str | None = None
    local: bool = False
    #: Written ``from``.
    source: Provenance | None = None


@dataclass(frozen=True, slots=True)
class Value:
    """A global value and its unit; :data:`DIMENSIONLESS` is written as a bare number."""

    value: int | float
    unit: str = DIMENSIONLESS


@dataclass(frozen=True, slots=True)
class Offering:
    """The composition's own pricing, by reference only: a SPHERE pricing or an HTTPS URL."""

    sphere: str | None = None
    registry: str | None = None
    url: str | None = None


@dataclass(frozen=True, slots=True)
class Evidence:
    """How the values were obtained: a run (and a point of its front), or by hand."""

    run: str | None = None
    point: int | None = None
    manual: bool = False
    #: Written ``evaluatedBy``.
    evaluated_by: Literal["gateway", "declared"] | None = None
    toolchain: str | None = None


@dataclass(frozen=True, slots=True, eq=False)
class Paths:
    """Where a document's workflow was read from.

    ``nodes`` maps the location of each node of the (normalised) workflow to its source
    path; ``leaves`` maps each task to the source path of its first leaf. A document built in
    code rather than read has neither.
    """

    nodes: Mapping[Location, Path] = field(default_factory=dict)
    leaves: Mapping[str, Path] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Document:
    """One Composition2Yaml document."""

    syntax_version: str
    composition: str
    version: str
    kind: str
    problem: ProblemLink | None
    workflow: Node
    binding: tuple[tuple[str, Entry], ...]
    values: tuple[tuple[str, Value], ...]
    offering: Offering | None = None
    evidence: Evidence | None = None
    paths: Paths = field(default_factory=Paths, compare=False, repr=False)

    def entry(self, task: str) -> Entry | None:
        """The binding of ``task``, if the document has one."""
        for name, entry in self.binding:
            if name == task:
                return entry
        return None

    def value(self, name: str) -> Value | None:
        """The value of property ``name``, if the document has one."""
        for key, value in self.values:
            if key == name:
                return value
        return None
