"""Compositions: Composition2Yaml documents, served by the platform (``/v1/compositions``).

The stateless language services (validate, parse, serialise, diff and the schema) and the
compositions of an organization. The language itself is the pure library
``openbinding_gateway.composition``; this module puts it behind HTTP, the work budget and the
per-process slots, and keeps the compositions. Layout and dependency rules:
docs/ARCHITECTURE.md §4.2.
"""
