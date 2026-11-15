# 0042. A composition links a problem by its semantic digest, and is evaluated on the installed compilation

- Status: accepted
- Date: 2026-11-15 (F1, decision D7 of the F1 implementation plan)

## Context

A composition's `problem` names a revision and a `compilation_digest`. A new toolchain release gives the same
revision another compilation digest, and the toolchain refuses to evaluate an IR it did not compile
(`contract_not_installed`). A link that broke on every release would make every verified composition stale, and one
that ignored releases would evaluate against a problem the toolchain now reads differently.

## Decision

- Every `problem_compilations` row stores a `semantic_digest`: the toolchain kit's formula, the canonical digest of
  the IR's `spec` without `profile`, `dialects`, `instance` and `sourceMap`, computed once in
  `modules/problems/domain/compilation.py`.
- Assessing a linked document resolves `L`, the stored compilation it names, and `I`, the installed toolchain's
  compilation of the same revision (compile-or-get). It always evaluates on `I`. With `I = L` nothing is said; with
  equal semantic digests the info `c2y_compilation_superseded`; with different ones the error
  `c2y_compilation_semantics_changed` (derive again). A missing `L` is `c2y_compilation_not_found`.
- Links stay within the composition's organization (`c2y_problem_foreign`, with no lookup elsewhere).
- After a seal the link is the stored `revision_id` and `linked_compilation_id`, never the text.

## Consequences

- A toolchain release that reads a problem alike keeps every link valid; one that reads it differently is reported,
  not hidden.
- Renaming an organization or a problem does not break a sealed version.
- The consumer-contract tests pin the gateway's semantic digest to the toolchain's.

Where: `modules/problems/domain/compilation.py`, `modules/compositions/application/assess.py`.
