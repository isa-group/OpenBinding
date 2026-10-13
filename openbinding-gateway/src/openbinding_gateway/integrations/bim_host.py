"""The host helpers of ``bim-core`` that the port does not offer.

Almost everything the gateway needs from BIM goes through ``BimPort`` (``integrations.bim``). Two
needs are about *one document*, not about a package, and the port has no operation for them:

* checking a single registered resource against the installed Dialect that claims it (JSON schema
  of the resource type, or the secure XML parse and OMG BPMN XSD validation), when someone
  registers a resource or seals a library version;
* checking an Engine manifest against the installed Profile it declares (``engine_contract_invalid``)
  when someone creates an Engine, before any IR exists.

``bim-core`` publishes both as host helpers (``docs/CONTRACT.md``: *Host helpers*, *Compatibility*)
and this is the only module of the gateway that imports them. They are pure functions of the
installed contracts, so with ``BIM_MODE=http`` they are only right when the local ``bim-core`` is the
toolchain of the service: ``integrations.bim.startup_check`` refuses to start otherwise.

If the port ever grows ``validate_resource`` and ``validate_engine``, this module goes away.
"""

from __future__ import annotations

from typing import Any

from bim_core import (
    InstancePackage,
    dialect_type_matches,
    dialect_xml_type_matches,
    engine_contract_diagnostics,
    resource_schema_diagnostics,
)

__all__ = [
    "XmlResource",
    "dialect_type_matches",
    "dialect_xml_type_matches",
    "engine_contract_diagnostics",
    "resource_schema_diagnostics",
]


class XmlResource:
    """A standalone XML resource: parsed securely by ``root`` and validated by ``validate_bpmn``.

    Both raise ``bim_core.PackageError`` for XML that is malformed, uses a forbidden construct or
    does not conform to the OMG BPMN 2.0.2 schema.
    """

    def __init__(self, content: bytes) -> None:
        self._package = InstancePackage({"instance.json": b"{}", "resource.xml": content})

    def root(self) -> Any:
        return self._package.xml_root("resource.xml")

    def validate_bpmn(self) -> Any:
        return self._package.xml("resource.xml")
