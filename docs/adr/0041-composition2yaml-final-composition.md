# 0041. Composition2Yaml is the document of a final composition

- Status: accepted
- Date: 2026-11-15 (F1, decisions D1 to D6 of the F1 implementation plan; owner decision of 2026-11-15 on the
  language's identity and versioning)

## Context

A BIM problem holds the space of alternatives: tasks, candidates, properties, constraints and objectives. What a
team adopts, versions, compares and later runs is one point of that space, with the values it yields, much as a
subscription is one choice in a Pricing2Yaml pricing. The problem-authoring language that held the name before was
never public and was removed in F0b ([ADR 0038](0038-old-composition2yaml-removed.md)).

Several things the redesign plan wrote could not hold against the toolchain: BIM binds exactly the service tasks
(local tasks exist in the corpus), a loop has `count` or `expectedCount`, blocks may have one child, a uniform
routing overlay is stored as floats that do not add up to 1, and a bare candidate id can be ambiguous across
catalogs.

## Decision

- Composition2Yaml declares a final composition: `composition`, `version` (semver), `kind` (metadata only), an
  optional `problem` link, `workflow`, `binding` (with an optional `from` provenance), `values`, an optional
  `offering` and optional `evidence`. Alternatives, constraints, objectives, demand and optimisation settings are
  never written in it (`c2y_problem_content`).
- It is versioned like Pricing2Yaml: a required, quoted `syntaxVersion` (`"1.0"`), independent of BIM releases; a
  minor version only adds optional keys. There is no "v1" or "v2" and nothing recognises the removed language.
- The reader runs size, syntax, the section readers, the coherence checks and the JSON Schema as a backstop, in that
  order, collecting every finding of a stage; every diagnostic carries a severity, a dotted path, a JSON Pointer and
  a span in one list (D1, D2).
- The workflow has task leaves, `null` for the empty step, `seq`/`and`/`xor` with one or more children, `xor`
  branches as nodes or `{probability, flow}`, `uniform: true` for equal routing, and `loop` with `count` or
  `expected`. Workflows are compared by position after the compiler's flattening (D3).
- Every task has exactly one binding entry; an in-house task is `{local: true}` and never reaches the toolchain
  (D4).
- A candidate is its id, or `<resource>/<id>` only when two catalogs give the task that id. The IR lookup only
  translates and locates; validity is the toolchain's verdict (D5, [ADR 0043](0043-values-only-from-bimport.md)).
- Without a problem, a bare number is dimensionless and any non-empty unit is accepted; unit errors are judged only
  against a problem (design choice C5).
- One canonical serialisation (D6, [ADR 0045](0045-composition-versions-canonical-bytes.md)).

## Consequences

- Derived documents always read back under their own rules: derive writes `uniform: true`, `{local: true}` and
  `<resource>/<id>` exactly where the reader needs them.
- "A task without an entry" is decidable without a problem.
- The specification is `docs/COMPOSITION2YAML.md`, whose marked examples are tests.

Where: `composition/` (`document.py`, `text.py`, `checks.py`, `workflow.py`), `docs/COMPOSITION2YAML.md`.
