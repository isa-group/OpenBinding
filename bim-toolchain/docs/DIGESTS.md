# Digests

Four different digests exist. Only one of them is meant to survive a change of toolchain.

| Digest | Where | Computed from | Changes when the toolchain bytes change |
| --- | --- | --- | --- |
| `compilerDigest` | `bim_core.compiler_bundle_digest()`, `adapter.binaryDigest` of every builtin Profile and Dialect, `compilation_digest` | every `.py` file and every file under `resources/` of the installed package | yes, by definition |
| `irDigest` | `BindingProblem.digest`, `bim_core.ir_digest(document)` | the IR document without `metadata` and without `spec.instance`, `spec.dialects`, `spec.sourceMap` | yes, because `spec.profile` stays in it |
| semantic digest | `semanticDigest` in `golden/bim_baseline/corpus.json` (`tools/baseline_core.py`) | `spec` without `profile`, `dialects`, `instance`, `sourceMap` | no |
| evaluations | `evaluation` in the baseline | the canonical evaluator applied to bindings | no |

All digests are `sha256-<hex>` over RFC 8785 (JCS) canonical JSON (`bim_core.digest`), or over raw bytes
(`bim_core.digest_bytes`) for files.

## compilerDigest

`compiler_bundle_digest()` walks the installed `bim_core` package with `importlib.resources`, keeps every
`*.py` file and every file under `resources/` (JSON Schemas, the engine contract, the vendored OMG XSDs), skips
`__pycache__` and `*.pyc`, and digests the mapping `{relative posix path: sha256(bytes)}` sorted by path. A file
that is added, removed, renamed or edited changes it; `py.typed` and files outside those two groups do not. The
result is memoised for the life of the process (`compiler_bundle_digest.cache_clear()` resets it).
`bim_core.toolchain.bundle_digest(root)` computes the same value for any directory tree, which is how the tests
show that adding a file changes the digest.

It is stored in the `adapter.binaryDigest` of the builtin Profile and Dialects. Their `version` carries build
metadata derived from their content (`1.0.0+<base32>`), so those versions and the `profile`/`dialects`
descriptors of an IR change with it too.

## irDigest

`BindingProblem.digest` is `ir_digest(document)`. It excludes the source representation and provenance, so a JSON
workflow and the equivalent BPMN workflow give the same value. It keeps `spec.profile`, whose descriptor pins the
Profile manifest and, through it, the `compilerDigest`. Consequently two toolchains that lower a package to the
same meaning still have different `irDigest`s.

`BindingProblem.from_document(document, verify=True, expected_digest=...)` recomputes it and compares with the
stored one, then requires the pinned Profile and Dialects to be exactly the installed ones. An IR produced by a
different toolchain therefore fails with `ContractError("contract_not_installed")`; it must be recompiled, or read
with `verify=False`.

`compilation_digest(package_digest, problem)` identifies one compilation:
`digest({"packageDigest", "profile", "dialects", "compilerDigest"})`. It is the formula OpenBinding used for
persisted snapshots.

## Why the values differ from OpenBinding

In OpenBinding `compilerDigest` covered only `canonical.py`, `compiler.py`, `expressions.py` and `package.py`,
and those modules read schemas and XSDs from locations outside the digest. Here the modules were edited (injected
limits, `importlib.resources`, error classes) and the digest covers all code and resources. The bytes are
different, so `compilerDigest`, the builtin Profile and Dialect versions and every `irDigest` are different. The
meaning was not changed on purpose; that claim rests on the semantic digest and the evaluations, never on
`irDigest`.

## How equivalence is proven

Compare, for every package of the corpus and every negative case, what must not move:

- the semantic digest and the per-section digests;
- the evaluation of every binding (or of a seeded sample when the space exceeds 2000);
- the code and location of every diagnostic of the negative cases.

`tools/baseline_core.py` computes them with `bim_core` only and
`packages/bim-core/tests/test_baseline_equivalence.py` compares them with `golden/bim_baseline`. Fields under a
`toolchain` key (`compilerDigest`, `irDigest`) are informative and are removed before comparing. Never use
`irDigest` or `compilerDigest` to argue that two toolchains are equivalent.

## Versioning rules

The package version follows SemVer. Every release changes `compilerDigest`; the rules say what else may change.

- **PATCH**: no valid package changes meaning. Semantic digests, evaluations and the codes and locations of
  diagnostics in the baseline are identical. Refactors, performance, documentation, message wording.
- **MINOR**: backward-compatible additions: new public API, new accepted constructs or dialect features, new
  diagnostics for constructs that were not valid before. Every package that compiled before still has the same
  semantic digest and evaluations.
- **MAJOR**: anything else: a valid package changes semantic digest or evaluation; a valid package is rejected;
  the IR schema or the engine protocol changes incompatibly; public names are removed or change meaning. A change
  of the `bim/v1` language itself is a new `bim/v2`.

A change that moves a golden is a MAJOR change unless the golden was wrong, and goldens are regenerated only in a
reviewed change that states why.
