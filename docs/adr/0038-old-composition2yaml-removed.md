# 0038. The problem-authoring Composition2Yaml is removed

- Status: accepted
- Date: 2026-11-14 (F0b, decision D27 of the F0b implementation plan)

## Context

The old Composition2Yaml authored problems, which belong to BIM, and its 82/82 round-trip gate to `qos-binding/v1`
no longer applied. Its routes sealed into project artifacts and lived under projects.

## Decision

F0b (B2) removed the language and its tooling: `routes/compositions.py`, `composition/{emit,text,checks}.py` and the
JSON Schema, the sealing path, `tools/check_composition_roundtrip.py` and its CI step, the frontend binding and diff
model, and the specification, replaced by a short note in `docs/COMPOSITION2YAML.md`. The reusable building blocks stay
in `openbinding-gateway/src/openbinding_gateway/composition/` with their tests: `diagnostics`, `syntax`, `spans`,
`ids`, `model`, `neutral`, `bpmn`, `read` and `diff`. The name Composition2Yaml passes to F1's document of a final
composition.

## Consequences

- F1 writes a new text layer on `syntax.py`; `text.py` and `checks.py` are rewritten from scratch there, and git
  history keeps the old ones.
- `syntax.py`'s refusal messages still name Composition2Yaml; they become the messages of F1's document syntax.

Later: F1 gave the name to the document of a final composition ([ADR 0041](0041-composition2yaml-final-composition.md))
and pruned `model`, `neutral`, `bpmn`, `read` and the old `diff` from the library (F1 D19); `diff.py` now compares
Composition2Yaml documents.

Where: `openbinding-gateway/src/openbinding_gateway/composition/`, `docs/COMPOSITION2YAML.md`.
