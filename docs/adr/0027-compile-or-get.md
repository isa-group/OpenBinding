# 0027. Compile-or-get, keyed by the compiler digest

- Status: accepted
- Date: 2026-11-14 (F0b, decision D6 of the F0b implementation plan)

## Context

Runs and studies need the compilation of a revision by the installed toolchain. The compilation digest is known only
after compiling, so it cannot be the lookup key; compiling on every run would waste work and escape the compile-class
rate limit.

## Decision

`compile_or_get` looks a compilation up by `(revision_id, compiler_digest)`. On a miss it reads the package back from
its blob, compiles it with no transaction held when asked to, and stores the result. The stored `compiler_digest` comes
from the compile result (`toolchain.compilerDigest`), the same source as `compilation_digest`, so the two keys are one
to one within a revision; both `UNIQUE(revision_id, compiler_digest)` and `UNIQUE(revision_id, compilation_digest)`
hold. Insertion uses a savepoint and re-selects on the key it looked up. Rows are insert-only: a toolchain release adds
a row and old runs keep the IR they ran on. A package the new toolchain refuses, or reads as another package, is `422
revision_not_recompilable`.

## Consequences

- `GET …/compilation` is in the compile work class, since it may compile.
- Tests swap the BIM port (`set_bim` / `bim_override`) to simulate a toolchain release instead of monkeypatching the
  cached digest.
- F1 adds `semantic_digest` to `problem_compilations` (deferred).

Where: `modules/problems/application/problems.py`, `tests/test_problem_compilations.py`.
