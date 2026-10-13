"""Checks about *one document* that the gateway asks of BIM: a registered resource, an Engine manifest.

They are not about a package, so ``BimPort`` has no operation for them; ``bim_client.BimResourcePort`` is the
extension that has, and the port of this process (``integrations.bim.get_bim()``) answers them:

* ``resource_schema_diagnostics``: a single registered resource against the schema of the installed Dialect
  that claims it (``validate_resource``), when someone registers a resource or seals a library version;
* ``XmlResource``: the secure XML parse and the OMG BPMN XSD validation of a standalone XML resource
  (``xml_resource_root`` / ``validate_bpmn_resource``);
* ``engine_contract_diagnostics``: an Engine manifest against the installed Profile it declares
  (``validate_engine``), when someone creates an Engine, before any IR exists.

``dialect_type_matches`` and ``dialect_xml_type_matches`` only select, among the Dialect manifests that
``BimPort.dialects()`` returned, the resource types that claim an identity; they are computed here on that data.

Both implementations of the port answer all of the above (``InProcessBim`` with ``bim-core``, ``HttpBim`` with
the ``/bim/v1/resources/...`` and ``/bim/v1/engines/validate`` endpoints of ``bim-service``), so with
``BIM_MODE=http`` none of this runs in the gateway process. This module does not import ``bim_core``.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .bim import get_bim

__all__ = [
    "XmlResource",
    "dialect_type_matches",
    "dialect_xml_type_matches",
    "engine_contract_diagnostics",
    "resource_schema_diagnostics",
]


class Diagnostic(dict):
    """A diagnostic as the port returns it (a JSON object) that also answers ``as_dict()`` like ``bim_core``'s."""

    def as_dict(self) -> dict[str, Any]:
        return dict(self)


def _port() -> Any:
    """The port of this process, seen as ``bim_client.BimResourcePort`` (this module does not import the client)."""
    return get_bim()


# --------------------------------------------------------------------------------- type matching


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


def dialect_xml_type_matches(
    dialects: Iterable[Mapping[str, Any]], namespace: str, local_name: str, media_type: str | None = None
) -> list[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    """``(dialect, resource type)`` pairs among ``dialects`` that claim an XML root element."""
    return [
        (dialect, resource_type)
        for dialect in dialects
        for resource_type in dialect.get("spec", {}).get("resourceTypes", [])
        if (media_type is None or resource_type.get("mediaType") == media_type)
        and resource_type.get("xmlRoot") == {"namespace": namespace, "localName": local_name}
    ]


# ------------------------------------------------------------------------------------ validation


def resource_schema_diagnostics(
    document: dict[str, Any],
    api_version: Any,
    kind: Any,
    media_type: Any,
    resource: str,
    dialects: list[dict[str, Any]] | None = None,
) -> list[Diagnostic]:
    """Findings of ``document`` against the schema of the Dialect that claims its type (empty if valid)."""
    found = _port().validate_resource(document, api_version, kind, media_type, resource, dialects)
    return [Diagnostic(item) for item in found]


def engine_contract_diagnostics(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Findings of an Engine manifest against the installed Profile it declares (empty if valid)."""
    return _port().validate_engine(document)


class _Root:
    """What the gateway reads of the root element of an XML resource: its tag, ``{namespace}name``."""

    def __init__(self, namespace: str, local_name: str) -> None:
        self.tag = f"{{{namespace}}}{local_name}" if namespace else local_name


class XmlResource:
    """A standalone XML resource: parsed securely by ``root`` and validated by ``validate_bpmn``.

    Both raise ``bim_core.PackageError`` for XML that is malformed, uses a forbidden construct or
    does not conform to the OMG BPMN 2.0.2 schema.
    """

    def __init__(self, content: bytes) -> None:
        self._content = content

    def root(self) -> _Root:
        found = _port().xml_resource_root(self._content)
        return _Root(found["namespace"], found["localName"])

    def validate_bpmn(self) -> None:
        _port().validate_bpmn_resource(self._content)
