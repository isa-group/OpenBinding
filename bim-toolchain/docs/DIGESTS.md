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
- the code and location of every diagnostic of the negative cases;
- the Engine mode compatibility of every package against every mode (`compat.json`);
- the re-evaluation and result-validation vectors (`vectors.json`);
- the protocol digest, the digests of the schemas, of the engine contract (bytes and parsed), of the manifests and
  of the vendored XSDs (`protocol.json`).

`tools/baseline_core.py` computes them with `bim_core` only and
`packages/bim-core/tests/test_baseline_equivalence.py` compares them with `golden/bim_baseline`. Fields under a
`toolchain` key (`compilerDigest`, `irDigest`) are informative and are removed before comparing. Never use
`irDigest` or `compilerDigest` to argue that two toolchains are equivalent.

### Result of the comparison (evaluation, compatibility, protocol)

| Golden | Result with `bim_core` only |
| --- | --- |
| `corpus.json` (82 packages), `negatives.json`, `vectors.json` | identical (`toolchain` fields aside) |
| `protocol.json` | `protocolDigest`, `engineContract`, `schemas` and `vendor` identical. `protocolDigest` does **not** change: the YAML contract and `binding-problem.schema.json` are byte-identical copies, and the digest is computed over the parsed document plus the schema bytes |
| `compat.json` | identical for the four Engines whose manifest exists; see the difference below |

**Legitimate difference: the Engine `meta-router-csp`.** `golden/bim_baseline/compat.json` and `protocol.json`
(the copy in this directory) list five Engines; the manifest `meta-router-csp.json` is not in
`schemas/bim/v1/manifests/` of the repository (only four are), so it cannot be a fixture and its entries cannot
be recomputed. Nothing else differs. OpenBinding's current goldens (`openbinding-gateway/tests/golden/bim_baseline`)
already list four Engines and are the same document as `golden/bim_core/{compat,protocol}.json` (the tests compare
them when OpenBinding is present), while the copy here still lists five. The original files are kept untouched;
the comparison removes the missing Engine from them (`baseline_core.without_engines`), and the same documents with
four Engines are pinned in `golden/bim_core/`.

## Goldens with no OpenBinding original

All are written by `tools/baseline_core.py` and are regression pins of this toolchain's output. They only gain
meaning because each is also compared with an independent source (below). A missing one is created by its test,
which fails once to say so (`conftest.check_or_create_golden`); delete a file to regenerate it, and review the
change. `toolchain` fields in them are informative.

| File | Why it exists | Independent evidence |
| --- | --- | --- |
| `golden/bim_core/compat.json`, `golden/bim_core/protocol.json` | the two documents with the four Engines that exist (reason above) | equal to the original minus `meta-router-csp`, and to OpenBinding's current files |
| `golden/bim_core/evaluator_errors.json` | `bim_core.evaluator.validate_binding` raises `EvaluationError` (a `ValueError`, code `binding_invalid`) where `BindingProblem.validate_binding` raises `ValueError`; the original `negatives.json` records the type name `ValueError` and stays as it is | same cases, same messages as `negatives.json`; only the type name differs |
| `golden/bim_core/zip_equivalence.json` | the package compiled from its ZIP against the package the goldens recorded from its directory: raw ZIP (must be equal), canonical ZIP (pins the 64 packages that differ, see "Directory, raw ZIP and canonical ZIP") | the directory and the raw ZIP are compiled in the same run; the semantic digest of the directory is the one in `corpus.json` |
| `golden/vectors_extra.json` | hostile engine answers: altered objectives, bindings outside the eligible space, `UNKNOWN`/`INFEASIBLE` with a binding, NaN/Infinity (written as `{"$float": ...}`), extra keys, unhashable and mistyped values | hand-written expectations in `tests/test_vectors_extra.py` (termination, number of solutions kept, `ProtocolError` code with and without `finite=True`) |

`toolchain` values stored in these files are those of the moment they were created and are never compared.

## Directory, raw ZIP and canonical ZIP

A package can reach the compiler in three forms: a directory, the ZIP of the bytes as written (what the platform
stores and compiles) and the canonical ZIP of `InstancePackage.to_zip()`, whose JSON resources are rewritten in
RFC 8785 form (members sorted) and whose XML is normalised to LF. They are not equivalent.

| Form | `packageDigest` | semantic digest, IR, `irDigest`, eligibility order |
| --- | --- | --- |
| directory, in any file-creation order | same | reference (what `golden/bim_baseline` records) |
| raw ZIP, entries in any order | same | **same as the directory** for all 82 corpus packages |
| canonical ZIP (`to_zip()`) | same | **same for 18 of 82 packages, different for 64** |

**Cause** (measured, `docs/qa/BIM_EQUIVALENCE.md` in OpenBinding): the enumeration order of the file system and the
order of the ZIP entries do not matter (`_read_directory` and `_validate_zip` fill a dictionary that the compiler only
reads by key or in sorted order). What matters is the order of the members of a JSON object. `to_zip()` sorts them
(`package.py` `_canonical_resource_bytes`, `to_zip`), while the compiler builds three IR lists by iterating objects in
document order: the eligible candidates of each task (`compiler.py` `_normalize_candidates`, from the order of the
catalogs in `instance.json` and of the candidates in each catalog), the constraints (`_constraints`, from the order of
the constraint sets and of the constraints) and the placement demands (`_placement`, from the order of groups and
catalogs). The provenance `spec.sourceMap` indexes those lists, so it moves with them. With the order of those lists
forgotten, the IR of the canonical ZIP equals the IR of the directory in every package.

Consequences: `irDigest` and the semantic digest depend on the *representation* of the package, not only on its
meaning; `compilation_digest` and `packageDigest` do not, so two compilations with the same `compilationDigest` can
have different IRs. The evaluation of one binding does not change, but exhaustive evaluations enumerate the bindings
in another order and sampled ones (`|S| > 2000`, seeded draws) pick other bindings, so the digests in enumeration
order, and for 33 sampled packages the summaries of the baseline, move.

**Not fixed, on purpose.** Sorting the three lists (and re-indexing `sourceMap`) would make all forms equal, but it
would move the semantic digest that `golden/bim_baseline` records for the 64 packages above and the order of their
evaluations: a change of the digest contract, MAJOR by the rules below, and by the stop rule of that work the goldens
are not regenerated to make a check pass. `bim-core` is unchanged, so its version (`0.1.0`, unreleased) and its
`compilerDigest` are unchanged. The divergence is pinned instead:

- `golden/bim_core/zip_equivalence.json` lists, per package, the `packageDigest`, whether the raw ZIP and the canonical
  ZIP compile to the same IR and semantic digest as the directory, the canonical ZIP's semantic digest and the sections
  that differ. `tools/baseline_core.py --check` fails if a raw ZIP differs from its directory (the production route)
  or if this document changes.
- `packages/bim-core/tests/test_zip_dir_equivalence.py` runs the comparison on synthetic packages without the corpus;
  the canonical-ZIP comparison of the unordered variants is a strict `xfail` with the cause, so the day the compiler
  changes, the test fails and this section, the version and the goldens must be updated together.
- The corpus run in OpenBinding (`openbinding-gateway/tests/test_bim_zip_dir_equivalence.py`) does the same for the 64
  packages.

If the decision is to canonicalise: sort `eligibility`, `constraints` and `placement` demands by a key that does not
depend on the document (for example `(resource, id)`), re-index `sourceMap`, declare it a MAJOR change, list the 64
packages as changed digests, regenerate `golden/bim_baseline` with `tools/baseline_core.py` in a reviewed change that
says why, and remove the `xfail`s.

## Digests that changed with this step

Adding `evaluator.py`, `reevaluate.py`, `protocol.py`, `compat.py`, `neighborhood.py` and `conformance.py` (and
`ContractError.http_status`) changes `compilerDigest`, which covers every `.py` file, and therefore the builtin
Profile and Dialect versions, their `adapter.binaryDigest` and every `irDigest`, exactly as a change of any code
would. This is expected; no semantic digest, evaluation, diagnostic, compatibility result or protocol digest
moved.

### Bounded expressions and ZIP reading

Bounding the integers of expressions (`Limits.max_integer_bits`) and reading ZIP entries in bounded chunks with a
method whitelist edits `settings.py`, `expressions.py`, `compiler.py` and `package.py`, so `compilerDigest`
changes again, together with the builtin Profile and Dialect versions (`1.0.0+<base32>`), their
`adapter.binaryDigest` and every `irDigest`:

| Value | After |
| --- | --- |
| `compilerDigest` | `sha256-e2f269aadbb75cb8c09fb3090a4e12b6b0999a11bbbd8de7c991185dd8605b23` |
| `qos-binding` Profile version | `1.0.0+ozo4bm7tpv3avkhc2tnzxc5u4bte6vcaso2gikkqbovpxrjwnh3q` |
| Dialect versions | `qos-binding` `1.0.0+ia2kmdnrpp7krzp243h376bgrqgely5krdh5fj6yfycn6rvpa2qq`, `bpmn-workflow` `1.0.0+ztsmwrkedtnjiyv5ds4p7jfwspzpwakoehfeoo2kyoceacnx2wfq`, `qos-binding-placement` `1.0.0+dhobxb3sxytcjhhw5mwc72y5epkwqstwgskwm3blqjpkhsx5qiqa` |

The `toolchain` fields stored in the goldens are informative and are not rewritten. Nothing that must not move
moved: the semantic digests, evaluations, diagnostics, compatibility results and protocol digest of
`golden/bim_baseline` and of the gateway's `tests/golden/bim_baseline` still compare equal
(`test_baseline_equivalence.py`, `test_bim_baseline.py`). `toolchain.json` is generated by
`tools/toolchain_json.py` and not versioned, so there is no file to regenerate.

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
