"""A summary of a sealed version, computed once from its canonical document and kept with it.

The editor draws how a composition evolved (its tasks, what they are bound to, the shape of its
workflow) from these numbers, without reading every version's document. The global values are not
here: they are the evaluation's (verified or declared, with their units).

* ``tasks``: the distinct tasks of the workflow; ``boundTasks`` those bound to a candidate and
  ``localTasks`` those done in house (``local: true``);
* ``providers``: the distinct candidates the binding chooses. The document names candidates, not the
  problem's catalog providers, so each chosen candidate counts as one provider of a service;
* ``upstreamPricings``: the distinct SPHERE pricings the candidates come from (``from.sphere``, with
  its registry when there is one);
* ``workflow``: how deep the blocks nest (a lone task is 0, a sequence of tasks 1) and how many
  ``xor``, ``and`` and ``loop`` blocks it has;
* ``hasOffering``: whether the document names its own offering.
"""

from __future__ import annotations

from typing import Any

from ....composition.document import Document
from ....composition.workflow import Exclusive, Parallel, Repeat, TaskNode, walk


def analytics(document: Document) -> dict[str, Any]:
    """The summary of ``document`` that a version stores."""
    nodes = list(walk(document.workflow))
    tasks = {node.task for _, node in nodes if isinstance(node, TaskNode)}
    bound = {task for task, entry in document.binding if entry.candidate is not None}
    local = {task for task, entry in document.binding if entry.local}
    providers = {entry.candidate for _, entry in document.binding if entry.candidate is not None}
    upstream = {
        (entry.source.registry, entry.source.sphere)
        for _, entry in document.binding
        if entry.source is not None and entry.source.sphere is not None
    }
    return {
        "tasks": len(tasks),
        "boundTasks": len(bound & tasks),
        "localTasks": len(local & tasks),
        "providers": len(providers),
        "upstreamPricings": len(upstream),
        "workflow": {
            "depth": max(len(location) for location, _ in nodes),
            "xor": sum(isinstance(node, Exclusive) for _, node in nodes),
            "and": sum(isinstance(node, Parallel) for _, node in nodes),
            "loop": sum(isinstance(node, Repeat) for _, node in nodes),
        },
        "hasOffering": document.offering is not None,
    }


__all__ = ["analytics"]
