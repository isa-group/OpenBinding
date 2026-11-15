"""Checks about *one document* that the gateway asks of BIM: an Engine manifest.

It is not about a package, so ``BimPort`` has no operation for it; ``bim_client.BimResourcePort`` is the
extension that has, and the port of this process (``integrations.bim.get_bim()``) answers it:

* ``engine_contract_diagnostics``: an Engine manifest against the installed Profile it declares
  (``validate_engine``), when someone creates an Engine, before any IR exists.

``dialect_type_matches`` only selects, among the Dialect manifests that ``BimPort.dialects()`` returned,
the resource types that claim an identity; it is computed here on that data.

The port answers the above (``InProcessBim`` with ``bim-core``). This module does not import
``bim_core``.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .bim import get_bim

__all__ = [
    "dialect_type_matches",
    "engine_contract_diagnostics",
]


def _port() -> Any:
    """The port of this process, seen as ``bim_client.BimResourcePort`` (this module does not import the client)."""
    return get_bim()


def dialect_type_matches(
    dialects: Iterable[Mapping[str, Any]], api_version: Any, kind: Any, media_type: Any
) -> list[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    """``(dialect, resource type)`` pairs among ``dialects`` that claim a JSON resource identity."""
    return [
        (dialect, resource_type)
        for dialect in dialects
        for resource_type in dialect.get("spec", {}).get("resourceTypes", [])
        if resource_type.get("apiVersion") == api_version
        and resource_type.get("kind") == kind
        and resource_type.get("mediaType") == media_type
    ]


def engine_contract_diagnostics(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Findings of an Engine manifest against the installed Profile it declares (empty if valid)."""
    return _port().validate_engine(document)
