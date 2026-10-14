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
| `golden/bim_normalized/corpus.json` | the baseline of the normalized IR (semantic digests, section digests, evaluations of the 82 packages); `golden/bim_baseline/corpus.json` is the frozen baseline of 0.1.x | `test_ir_previous_baseline.py`: the 18 unmoved packages have the same entry, the 64 moved ones differ in `eligibility`, `constraints` and `placement` only, and every package has the previous toolchain's members and evaluations by identifier |
| `golden/bim_normalized/zip_equivalence.json` | the package compiled from each other form (raw ZIP, entries reversed, canonical ZIP, two shuffles of the JSON members) against the package compiled from its directory: all equal (see "Directory, raw ZIP and canonical ZIP") | the forms are compiled in the same run; the semantic digest of the directory is the one in `bim_normalized/corpus.json` |
| `golden/ir_previous/evidence.json` | what the 0.1.x toolchain computed by identifier: the SHA-256 of the frozen `golden/bim_baseline` files, the evaluation of bindings chosen by identifier and the digest of the members of every set of the IR, for the 82 packages. It can only be created by that toolchain (`build_previous_evidence` refuses any other) | the frozen files, which come from OpenBinding |
| `golden/vectors_extra.json` | hostile engine answers: altered objectives, bindings outside the eligible space, `UNKNOWN`/`INFEASIBLE` with a binding, NaN/Infinity (written as `{"$float": ...}`), extra keys, unhashable and mistyped values | hand-written expectations in `tests/test_vectors_extra.py` (termination, number of solutions kept, `ProtocolError` code with and without `finite=True`) |

`toolchain` values stored in these files are those of the moment they were created and are never compared.

## Directory, raw ZIP and canonical ZIP

A package can reach the compiler in several forms: a directory, the ZIP of the bytes as written (what the platform
stores and compiles) in any order of entries, the canonical ZIP of `InstancePackage.to_zip()`, whose JSON resources are
rewritten in RFC 8785 form (members sorted) and whose XML is normalised to LF, and any rewriting of the JSON that only
moves the members of its objects. Since 0.2.0 they are equivalent.

| Form | `packageDigest` | semantic digest, IR, `irDigest`, eligibility order, evaluations |
| --- | --- | --- |
| directory, in any file-creation order | same | reference |
| raw ZIP, entries in any order | same | same as the directory, 82 of 82 |
| canonical ZIP (`to_zip()`) | same | same as the directory, 82 of 82 (until 0.1.x: 18 of 82) |
| members of the JSON objects shuffled | same | same as the directory, 82 of 82 for two seeds |

**Rule.** JSON gives no meaning to the order of the members of an object, so a list that the compiler builds by
iterating objects is a *set* and is written in one canonical order, decided at compile time and independent of how the
package was serialized (not by the ZIP writer): `eligibility[task]` by `(catalog id, candidate id)`, `constraints` by
`ref`, `placement` by resource id, and inside a model `demands` by candidate and `transitions` by `ref`
(`bim-core` `compiler.py`: `_normalize_candidates`, `_constraints`, `_placement`; `docs/CONTRACT.md`, "Order of the sets
of the IR"). The provenance `spec.sourceMap` indexes `constraints` and `placement`, so it is written after sorting. An
array that the author writes as an array keeps its order: it is data. An integral number is read as an integer
(`canonical.integral_numbers`), because the canonical form cannot tell `6.0` from `6`. This is a change of the digest
contract, MAJOR by the rules below; see [`docs/qa/IR_NORMALIZATION.md`](../../docs/qa/IR_NORMALIZATION.md) for the
classification of each list and the evidence.

**What 0.1.x did** (measured, `docs/qa/BIM_EQUIVALENCE.md`): the enumeration order of the file system and the order of
the ZIP entries never mattered (`_read_directory` and `_validate_zip` fill a dictionary that the compiler only reads by
key or in sorted order); the order of the members of a JSON object did, because `to_zip()` sorts them while the compiler
iterated them in document order. 64 of the 82 corpus packages had another IR, `irDigest` and semantic digest from their
canonical ZIP than from their directory, and `compilation_digest` and `packageDigest`, which do not contain the IR, could
not tell the two apart.

Consequences of the change: `irDigest` and the semantic digest depend on the *meaning* of the package again, and two
compilations with the same `compilationDigest` have the same IR. The evaluation of a binding is the same (checked by
identifier, below), but exhaustive evaluations enumerate the bindings in the canonical order and sampled ones
(`|S| > 2000`, seeded draws) index the canonical lists, so the digests in enumeration order of the 64 packages that moved
and, for 33 sampled ones, the summaries of the baseline, are those of `golden/bim_normalized`, not of `golden/bim_baseline`.

**Two baselines.** `golden/bim_baseline` is the baseline of 0.1.x (OpenBinding's, commit `b2780381`): frozen, never
written, with its SHA-256 pinned in `golden/ir_previous/evidence.json`. It is the comparison fixture of the normalized
toolchain, which has no code for the old order. `golden/ir_previous/evidence.json` also holds what that toolchain
computed *by identifier*: the evaluation of bindings chosen by identifier (never by position in a list) and the digest
of the members of every set of the IR, order forgotten, for the 82 packages. `test_ir_previous_baseline.py` requires the
current toolchain to reproduce all of it (violations compared as a set; a message with `6.0` reads `6`) and the
exhaustive summaries of `golden/bim_baseline/corpus.json`. `golden/bim_normalized/{corpus,zip_equivalence}.json` is
the baseline of 0.2.0, created once those invariants held. `negatives.json`, `vectors.json`, `compat.json` and
`protocol.json` did not move and are still compared with the frozen baseline.

- `golden/bim_normalized/zip_equivalence.json` lists, per package, the `packageDigest` and whether each form compiles to
  the same IR and semantic digest as the directory. `tools/baseline_core.py --check` fails if any does not.
- `packages/bim-core/tests/test_zip_dir_equivalence.py` (synthetic, no corpus) and `test_zip_dir_equivalence_corpus.py`
  (82 packages) run the comparison, with shuffled members, and require identical evaluations; the cases that were
  strict `xfail` (the four `unordered-*` variants and 64 corpus packages) are ordinary tests.
- The corpus run in OpenBinding (`openbinding-gateway/tests/test_bim_zip_dir_equivalence.py`) still expects the 0.1.x
  divergence (strict `xfail`): its owner updates it (`docs/qa/IR_NORMALIZATION.md`).

## Digests that changed with the normalization of the IR (0.2.0)

`compiler.py` (the order of the sets, integral numbers, `binding_space_cardinality_decimal`), `canonical.py`,
`expressions.py` (`has`) and `_version.py` changed, so `compilerDigest`, the builtin Profile and Dialect versions, their
`adapter.binaryDigest` and every `irDigest` changed. Unlike the steps below, **the semantic digest of 64 of the 82
corpus packages moved too** (and with it the enumeration order of their exhaustive evaluations and the seeds'
draws): this is a MAJOR change under the versioning rules, recorded as `semantic-change` in `CHANGELOG.md`.

| Value | Before (0.1.x) | After (0.2.0) |
| --- | --- | --- |
| `compilerDigest` | `sha256-e2f269aadbb75cb8c09fb3090a4e12b6b0999a11bbbd8de7c991185dd8605b23` | `sha256-ccc55839be2e311d7adfe3c44ee0a70a6e7b19acb28b786f8dee6a8da593418e` |
| `qos-binding` Profile version | `1.0.0+ozo4bm7tpv3avkhc2tnzxc5u4bte6vcaso2gikkqbovpxrjwnh3q` | `1.0.0+csdgtbuugavgxg3a7h3w2x6h2ixunyufqwvisq2makw6kv7dehwq` |
| Dialect `qos-binding` | `1.0.0+ia2kmdnrpp7krzp243h376bgrqgely5krdh5fj6yfycn6rvpa2qq` | `1.0.0+jdok6lhcwa6wt5c2st5jdppigjh4gwnczpyg77inamuet7qyt7zq` |
| Dialect `bpmn-workflow` | `1.0.0+ztsmwrkedtnjiyv5ds4p7jfwspzpwakoehfeoo2kyoceacnx2wfq` | `1.0.0+jmfo6wmfcspi3d7khvjn7sikgmcgwnvxwesfq4xlljcrwotfipya` |
| Dialect `qos-binding-placement` | `1.0.0+dhobxb3sxytcjhhw5mwc72y5epkwqstwgskwm3blqjpkhsx5qiqa` | `1.0.0+yizryf6yoacyp77d3dggiuzsknmlik2gkdbmyavjx3haiq2auhja` |
| `irDigest` of the consumer demo package (`tools/consumer_fixtures.py`) | `sha256-35202caa0d1a5f1b4e17ea0feb1ba8c67dcfca7ff7a0ecb97644f345d041bcba` | `sha256-0dcc0b0a230d45cf768edef5f0da70f0ca366c8ab29c3e8168c3c16328c22270` |

The "before" values are those of the section below (the last change of `bim_core` before this one) and of the consumer
fixtures. What did **not** move: `packageDigest`, `inputDigest`, `instanceDigest`, the semantic digest of the 18 packages
whose sets were already in canonical order, the digests of the schemas, the engine contract and the protocol, the
negative cases (`negatives.json`), the re-evaluation vectors (`vectors.json`), the Engine compatibility of every package
(`compat.json`), and the exhaustive summaries. `contracts/openapi/bim-service.v1.json` changes only in `info.version`.

## Digests that changed with an earlier step

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

Before 1.0 the minor number marks a MAJOR change (SemVer, "major version zero"): the normalization of the IR order,
which moved 64 semantic digests, is `0.2.0`, and `bim-service` and `bim-client` widen `bim-core>=0.1,<0.2` to
`bim-core>=0.2,<0.3`.

A change that moves a golden is a MAJOR change unless the golden was wrong, and goldens are regenerated only in a
reviewed change that states why. A golden that a MAJOR change moves is not overwritten: the previous one is kept as a
frozen fixture (`golden/bim_baseline`, pinned by SHA-256 in `golden/ir_previous/evidence.json`), the new one goes to
`golden/bim_normalized`, and a test compares the two by identifier before the new one is created.
