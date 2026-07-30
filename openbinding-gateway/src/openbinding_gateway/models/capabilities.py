"""What an engine may claim it can do.

The four engines in this repository each return a ``get_capabilities()`` dict,
and until now those dicts were decorative: nothing compared them against the
general schema, so a typo advertised a capability that does not exist and a
missing entry hid one that does. That was survivable while every plugin was
reviewed as code in a pull request. It stops being survivable when a stranger
declares capabilities in a manifest.

So the vocabulary lives here, derived from the general schema rather than from
the plugins:

* composition node kinds are the ``kind`` discriminators in
  ``schemas/general/application-model.schema.json``;
* objective types are the three in ``objective.schema.json``;
* constraint families are the ``kind`` values in ``constraints.schema.json``,
  plus the latency constraints that ride in ``latency_model``.

One wrinkle is recorded rather than hidden: the built-in plugins spell
constraint families in lower snake case (``attribute_bound``) while the schema
spells the same thing in upper snake case (``ATTRIBUTE_BOUND``). Both are
accepted on input and normalised to the plugins' spelling, because that is what
``GET /v1/engines`` has published for as long as it has existed and changing it
would break clients to fix a cosmetic inconsistency.
"""

from __future__ import annotations

from typing import Iterable, List, Set

#: Every composition node the general schema defines. An engine that omits one
#: is refusing instances that use it, which is a legitimate thing to declare.
COMPOSITION_NODES: Set[str] = {"TASK", "ELEMENT", "SEQ", "AND", "XOR", "LOOP"}

#: MONO is a single weighted objective, MULTI two or three, MANY more.
OBJECTIVE_TYPES: Set[str] = {"MONO", "MULTI", "MANY"}

#: Constraint families, in the spelling the engines endpoint publishes.
CONSTRAINT_FAMILIES: Set[str] = {
    "attribute_bound",
    "dependency",
    "resource_capacity",
    "latency_transition",
}

#: An engine is either exhaustive or it is not, and the difference is not
#: cosmetic: the router reports INFEASIBLE rather than UNKNOWN when an EXACT
#: engine finds nothing, so claiming EXACT falsely turns "I did not find one"
#: into "there is none".
ENGINE_TYPES: Set[str] = {"EXACT", "HEURISTIC"}

#: The wildcard an engine uses to say it places no restriction on QoS feature
#: names. All four built-ins use it.
ANY = "*"


def normalise_constraint_family(value: str) -> str:
    """The engines endpoint's spelling of a constraint family.

    Accepts either case so that a manifest written against the schema and one
    written against ``GET /v1/engines`` both work.
    """
    return value.strip().lower()


def normalise_upper(value: str) -> str:
    return value.strip().upper()


def unknown(values: Iterable[str], vocabulary: Set[str], *, upper: bool) -> List[str]:
    """Which of ``values`` are not in the vocabulary, in input order.

    Returns the offending values as written, not as normalised, because an
    error message that echoes something the author did not type is a worse
    error message.
    """
    offenders: List[str] = []
    for value in values:
        if not isinstance(value, str):
            offenders.append(repr(value))
            continue
        if value == ANY:
            continue
        candidate = normalise_upper(value) if upper else normalise_constraint_family(value)
        if candidate not in vocabulary:
            offenders.append(value)
    return offenders
