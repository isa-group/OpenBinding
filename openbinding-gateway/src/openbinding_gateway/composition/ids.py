"""The identifiers a composition compiles to, all of which are visible in the IR digest.

Nothing here is cosmetic. The container's IR digest strips metadata and a few control
sections and keeps everything else, so every id this module derives is part of the
identity of the compiled problem. Two consequences shape the whole module:

* Every id is a **pure function** of the source -- never a counter, a clock, a hash of a
  float or a UUID. The same composition must give the same ids on every machine and in
  every process.
* **No id is minted for a workflow node.** The container accepts an ``id`` on any node,
  copies it into the IR and does not strip it; its sequence flattening also refuses to
  flatten a nested sequence that carries one. No package in the corpus uses a node id,
  so minting them would move the digest of every package the Studio touches, and there is
  no golden that would catch a partial mistake -- only the digest would move.

Branch ids are the one id the Studio does derive, because an exclusive choice is split
across two documents and the branch id is the join key between them.
"""

from __future__ import annotations

import re

#: Resource ids are part of the IR: the compiled problem names the application and the
#: optimization by resource, and keys candidates by their catalog's resource id. 82 of the
#: 83 corpus packages use these five -- the exception is the toolchain's own example
#: fixture -- so they are normative here rather than conventional. Naming the catalog
#: anything else yields a semantically identical package with a different digest and no
#: hint why. A placement resource, which this version cannot express, is a sixth id.
APPLICATION = "application"
CATALOG = "catalog"
ROUTING = "routing"
CONSTRAINTS = "constraints"
OPTIMIZATION = "optimization"

#: The profile role each resource is declared under in the package manifest. The routing
#: overlay belongs to the candidate-catalog role, not to the application role: the
#: authoring guide and the placement document both say otherwise, and the profile
#: manifest in the compiler is the authority.
ROLES: dict[str, str] = {
    APPLICATION: "application",
    CATALOG: "candidateCatalog",
    ROUTING: "candidateCatalog",
    CONSTRAINTS: "constraintSet",
    OPTIMIZATION: "optimization",
}

#: Task, feature and candidate ids; the container's own pattern for a map key.
SYMBOL = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,127}$")
#: Document names; the container's own pattern for ``metadata.name``.
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def branch_id(exclusive_id: str, position: int) -> str:
    """The id of the branch at ``position`` (one-based) of an exclusive choice.

    The author gives the exclusive its id and the position comes from source order, so
    the result is stable across processes and machines. An exclusive that carries
    probabilities and has no id is refused rather than given an invented one.
    """
    if position < 1:
        raise ValueError(f"branch positions are one-based, got {position}")
    return f"{exclusive_id}_branch_{position}"


def fixed_capability(task_id: str) -> str:
    """The capability type minted for a fixed task, so exactly one candidate matches.

    A catalog never lists task ids: eligibility is capability matching between a task's
    requirement and a candidate's offer. A fixed task is therefore a service task with a
    requirement no other candidate claims, plus the single candidate that claims it.
    """
    return f"fixed/{task_id}"


def fixed_candidate(task_id: str) -> str:
    """The id of the one candidate of a fixed task."""
    return f"cand_{task_id}"


def document_name(composition: str, resource: str) -> str:
    """``metadata.name`` of one emitted document.

    The composition id carries the identity; the resource suffix keeps the five documents
    of one package distinguishable, which is what the corpus does too.
    """
    return f"{composition}_{resource}"


def exclusive_stem(first_branch_id: str | None, position: int) -> str:
    """The id an imported exclusive choice takes, recovered from its branches.

    An exclusive's own id is never emitted -- the branches carry theirs, and an imported
    composition keeps those verbatim -- but the model requires one, so it has to be derived
    the same way wherever a package is read: from a source document, or lifted out of a
    reduced BPMN workflow. Two rules for one derivation give two models for one package,
    which is a difference no digest would ever show.

    When the branch ids follow the ``{stem}_branch_{n}`` scheme the stem is recovered;
    otherwise the one-based position in source order stands in for it.
    """
    if first_branch_id and first_branch_id.endswith("_branch_1"):
        return first_branch_id[: -len("_branch_1")]
    return f"exclusive_{position}"
