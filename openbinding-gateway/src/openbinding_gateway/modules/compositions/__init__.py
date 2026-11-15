"""Compositions: Composition2Yaml documents, served by the platform (``/v1/compositions``).

Today the stateless language services: validate, parse, serialise, diff and the schema. The
language itself is the pure library ``openbinding_gateway.composition``; this module puts it
behind HTTP, the work budget and the per-process slots. Layout and dependency rules:
docs/ARCHITECTURE.md §4.2.
"""
