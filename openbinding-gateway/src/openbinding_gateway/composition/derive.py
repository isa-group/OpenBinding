"""The Composition2Yaml document of a binding of a compiled problem.

:func:`derived` builds the document a binding derives to: the problem's workflow, the binding
as a document writes it, the values the evaluator computed for it with the problem's units,
and the link, evidence and offering the caller gives. It is pure and deterministic -- the same
inputs give the same document, and so the same canonical bytes -- and it writes only what its
own reader and checks accept:

* an exclusive choice whose routed probabilities are all equal is written ``uniform: true``,
  without them (a three-way choice is ``0.3333333333333333`` three times, whose exact sum is
  not one); any other routed choice states its probabilities, exactly as the IR has them;
* a local task is bound ``{local: true}``;
* no ``from`` is written: provenance comes from the problem's value origins, later.

Evaluating the binding is the caller's: the toolchain computes the values, never this module.
"""

from __future__ import annotations

from typing import Any, Mapping

from .document import SYNTAX_VERSION, Document, Evidence, Offering, ProblemLink, ProblemRef
from .problem import ProblemFacts, computed_values, document_binding
from .workflow import Branch, Exclusive, Node, Parallel, Repeat, Sequence


def derived(
    *,
    slug: str,
    label: str,
    kind: str,
    problem_ref: ProblemRef,
    compilation_digest: str,
    facts: ProblemFacts,
    bim_binding: Mapping[str, Mapping[str, Any]],
    features: Mapping[str, float],
    evidence: Evidence,
    offering: Offering | None = None,
) -> Document:
    """The document of ``bim_binding``, whose evaluated features are ``features``."""
    return Document(
        syntax_version=SYNTAX_VERSION,
        composition=slug,
        version=label,
        kind=kind,
        problem=ProblemLink(ref=problem_ref, compilation=compilation_digest),
        workflow=written(facts.workflow),
        binding=document_binding(bim_binding, facts),
        values=computed_values(features, facts),
        offering=offering,
        evidence=evidence,
    )


def written(node: Node) -> Node:
    """A problem's workflow as a document writes it: a uniform choice without its probabilities."""
    if isinstance(node, Sequence):
        return Sequence(tuple(written(child) for child in node.children))
    if isinstance(node, Parallel):
        return Parallel(tuple(written(child) for child in node.children))
    if isinstance(node, Exclusive):
        return Exclusive(
            branches=tuple(
                Branch(flow=written(branch.flow), probability=None if node.uniform else branch.probability)
                for branch in node.branches
            ),
            uniform=node.uniform,
        )
    if isinstance(node, Repeat):
        return Repeat(body=written(node.body), count=node.count, expected=node.expected)
    return node
