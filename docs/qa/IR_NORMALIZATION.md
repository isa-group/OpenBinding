# Normalization of the IR order (`bim-core` 0.2.0)

Date: 2026-10-14. Authorization: decision of the owner of 2026-10-14, which replaces the earlier ban on changing the IR,
`bim-core`, the goldens and the digests. This document records what was classified, what was decided, how the change was
shown not to alter any meaning, and what it moves outside `bim-toolchain`. It supersedes the "not applied" decisions of
`docs/qa/BIM_EQUIVALENCE.md` §3 and `docs/qa/analysis/BIM_B5_B8_M4_IR.md` §4.5-4.6.

**Status: normalized.** A directory, the ZIP of its bytes (either order of entries), its canonical ZIP and the same
package with the members of its JSON objects shuffled compile to the same IR, byte for byte (canonical JSON), and evaluate
every binding to the same evaluation, in 82 of 82 corpus packages and in the five synthetic variants. No compatibility
mode, no second implementation of the old order and no migration code exist: the old behaviour is preserved only as data.

## 0. The baselines, by SHA

| Baseline | Where | Identity |
| --- | --- | --- |
| Previous (0.1.x): IR lists in document order | `bim-toolchain/golden/bim_baseline/` (frozen; copies of `openbinding-gateway/tests/golden/bim_baseline/`) | commit **`b2780381`** (the baseline), generated at head **`f7f6fdb`**; SHA-256: `corpus.json` `0ca465a0230c96aa4e44bba54cc73dba9d0a1c98adb4325b9699d194cdd9bfec`, `negatives.json` `b7247d241d21c7086e716c4cfeea92af0785b55fba02f0b0ef1f03ed0f0e4194`, `vectors.json` `91d283706f6801245758e28a5968958056fe372f4e53e33ef0e48b28eecaaedb`, `compat.json` `8f6f3ac94d1bf59235a328644965c3f9df512010469caae836f5a0aec21759a8`, `protocol.json` `700f211018835c44352535ebfebeb3c71dbb1ad47fa4c48048623a963ca03ccc` |
| Previous, by identifier | `bim-toolchain/golden/ir_previous/evidence.json` | created by the **unchanged** compiler at `f7f6fdb` before any edit of `bim_core`; holds the SHA-256 above (a test fails if a frozen file is edited), 1 582 evaluations of bindings chosen by identifier and the digest of the members of every set of the IR, for the 82 packages |
| Current (0.2.0) | `bim-toolchain/golden/bim_normalized/{corpus,zip_equivalence}.json` | created after the invariants of §4 held |

`golden/bim_baseline` is the comparison fixture: `tools/baseline_core.py` never writes it, and
`build_previous_evidence` refuses to produce the evidence from any toolchain whose 82 semantic digests are not those of
that baseline, so the normalized compiler cannot rewrite its own past.

## 1. Reproduction and classification of the divergences

### 1.1 What was reproduced (head `f7f6fdb`, compiler untouched)

Registered check 0 on the unchanged compiler (with the new harness only): 1 307 passed, 1 failed (the creation of the
evidence, by design), **69 xfailed = 64 + 4 + 1**:

* 64 strict `xfail` of `test_zip_dir_equivalence_corpus.py`: the canonical ZIP of 64 of the 82 packages compiles to another
  IR than the directory (`irDigest`, semantic digest, `sourceMap`).
* 4 strict `xfail` `unordered-*` of `test_zip_dir_equivalence.py` (`unordered-catalogs`, `unordered-candidates`: `spec.eligibility`;
  `unordered-constraint-sets`, `unordered-constraints`: `spec.constraints`).
* 1 strict `xfail` of `test_language_final_evaluation.py` (`has()` on an interval slot): **another bug, not an order
  problem** (§5.1).

Per list, from `test_analysis_ir_probe.py` on the same corpus (before the change): `eligibility` differs in 46 packages,
`constraints` in 59, `placement` in 7, `placement[].demands` in 2, `transitions` in 7, `network` and `capacityRules` in 0;
`sourceMap` follows. A seeded draw from `eligibility` picks another binding in the 46 packages whose lists differ. The
canonical ZIP and the directory evaluated 492 bindings (6 for each package): 313 identically, 164 differing only in the
order of `violations`, 9 only in the text of a message, 6 in both, 0 otherwise.

### 1.2 Cause

JSON gives no meaning to the order of the members of an object; the canonical form (`to_zip()`, RFC 8785) sorts them. The
compiler built the lists below by iterating objects in document order, so its output depended on how the package was
serialized. A second, independent difference came from the number model: the directory holds `6.0`, the canonical form
writes `6` (`maximum 6.0` against `maximum 6` in a transition message, 7 placement packages).

### 1.3 Classification

*Set* = a list built by iterating objects, whose order carries no meaning and must not depend on serialization. *Sequence*
= an array the author writes, whose order is data.

| Where | Built from | Verdict | Real example |
| --- | --- | --- | --- |
| `spec.eligibility[task]` | catalogs × candidates (objects) | **set** for correctness (membership, count, neighbourhood sorts); **index space** for engines with seeds | `examples/demo/05_multi_obj/candidates.json` writes `c_fast_expensive, c_slow_cheap, c_balanced, c_bad`: the directory listed the eligible candidates in that order, the canonical ZIP as `c_bad, c_balanced, c_fast_expensive, c_slow_cheap` |
| `spec.constraints` | constraint sets × constraints (objects) | **set**; its order is the order of `violations` and of a floating-point sum | `examples/placement/01_small_placement/constraints.json` writes `security_min_login, budget_global, check_and_rules_together`; `sourceMap` `/spec/constraints/0` pointed at `security_min_login` from the directory and at `budget_global` from the ZIP |
| `spec.placement` (models) | placement resources | **set** (key `resource`) | the corpus has one model per package, so this order is not exercised by data (§6) |
| `placement[].demands` | groups (objects) and, if selected by capability, catalogs; the author's `demands` array overrides | **set** (map candidate → pool); the author's array order is not data once keyed | 2 packages differed (`01_small_placement` writes its `demands` array as `c_cloud, c_edge, c_fog`, already sorted) |
| `placement[].transitions` | transitions (object) | **set**; order visible in `violations` | `01_small_placement`: `tr_login_process, tr_event_login` |
| `spec.sourceMap` | `/spec/constraints/<i>`, `/spec/placement/<i>/...` | derived index into the sets above | re-generated after sorting |
| `workflow` (`sequence`, `exclusive`, `parallel`, BPMN) | author arrays / XML | **sequence**: control flow | `01_simple_seq`: `t1 → t2 → t3` |
| `optimization.criteria` | author array | **sequence**: `objectives.components` and a vector `score` follow its order (lexicographic convention, `neighborhood.py`) | `05_multi_obj/optimization.json`: `cost`, then `latency` |
| `optimization.penalties` | author array | **sequence**: `solution.penalties` of `bim-engine/v1` is aligned with it by position | `reevaluate.py:109-117` |
| `placement[].capacityRules` | author array | **sequence and identity**: a rule is `capacityRules/<i>` | `01_small_placement`: `capacityRules/0` |
| `placement[].network`, `events[].latency`, `routing.entries` | author arrays | **sequence** (duplicates are refused by pair; symmetric mirroring appends in this order); unchanged in the 82 packages | `01_small_placement` |
| expression arguments (`args` of `weightedSum`, `weights`) | AST | **sequence**: positional | — |
| dictionaries (`tasks`, `features`, `candidates`, `pools`, `events`, `extensions`) | objects | not lists: the canonical JSON sorts their keys | — |

The 64 packages that changed are exactly those with at least one `set` out of canonical order
(`packages/bim-core/tests/data/zip_divergent_packages.json`); the other 18 were already in it.

## 2. The order chosen and why

**One total order by identifier, decided at compile time**: `eligibility[task]` by `(catalog id, candidate id)`;
`constraints` by `(constraint set id, constraint id)`; `placement` by resource id; inside a model, `demands` by
`(candidate catalog, candidate id)` and `transitions` by `(set id, transition id)`. Strings compare as Python compares them
(code point by code point). `sourceMap` entries that carry a position are written after sorting.

Why this one:

* **Total and free of ties.** Resource ids are unique in an instance, candidate ids in a catalog, constraint ids in a
  set, transition ids in a model; `(resource, id)` is therefore a key, and no tie-break or stability argument is needed.
* **Independent of serialization.** It uses only identifiers, never the position a member had in a file. It is applied
  in `compile_instance`, not in `to_zip()`, so the raw ZIP and the directory (which `to_zip()` never touches) get it too.
* **Documentable and checkable by a reader.** "Sorted by name" is a rule an engine author or a gateway can recompute.
  `test_analysis_ir_probe.py` keeps an independent reference implementation (`normalized`) and requires every IR to be
  its own fixed point.
* Rejected: sorting only in `to_zip()` (leaves the directory and the raw ZIP different, and the raw ZIP is the production
  route); keeping first appearance (depends on the file); sorting arrays too (changes meaning, §1.3).
* The code-point order differs from the UTF-16 order the canonical JSON uses for keys only for supplementary-plane
  characters; the two orders never meet, because lists are ordered here and objects there.

**Number model.** A parsed JSON number that is integral (`6.0`, `1e3`, `-0.0`) and at most `2**53 - 1` in magnitude is read
as an integer (`bim_core.canonical.integral_numbers`, applied to `instance.json` and to every resource document before
compilation), because the canonical form cannot tell `6.0` from `6`. Larger floats, fractions and exponent forms are
kept. This makes the transition message read `maximum 6` from every form. It is visible to any consumer that digests the
IR with Python's `json.dumps` instead of canonical JSON (§7).

**Diagnostics.** The order of the diagnostics of an invalid package still follows the order of the document. What is
required, and tested, is that their set (code, resource, location) does not change when the members are shuffled
(§4.4); the order of the list is not an identifier-ordered set and was not changed.

### 2.1 Positions, indices and references: what was checked

| Place | Uses a position? | Result |
| --- | --- | --- |
| `sourceMap` `/spec/constraints/<i>`, `/spec/placement/<i>/...` | yes, into the sorted sets | generated after sorting; `test_the_ir_of_a_package_lists_its_sets_in_the_canonical_order` checks, for 82 packages, that every index points at its member |
| `sourceMap` `/spec/placement/<i>/capacityRules/<j>`, `.../globalLatency` | `<j>` into an author array | unchanged |
| `capacityRules/<i>` in `ref` | identity by position | not sorted (§1.3) |
| bindings, `validate_binding`, `evaluate`, `evaluator.py` | no: `{resource, id}`; eligibility is tested by membership | unchanged |
| `analyze_neighborhood` | no: sorts the candidates by `(resource, id)` itself (`neighborhood.py:89-94`) | its output is identical for the five synthetic variants |
| `reevaluate_result` | decisions by `{resource, id}`; `penalties` by position in `optimization.penalties` (author array) | unchanged; identical for the five variants |
| `bim-engine/v1` (`engine-contract.openapi.yaml`, `protocol.py`) | no field is an index: decisions, violations and constraint references name `{resource, id}`; the contract has no `index`, `ordinal` or `position` | unchanged |
| Engines with seeds (`engines/**`: `eligible.get(random.nextInt(n))` in `V1RandomSearch`, `EvolutionarySolver`, `V1ManySearch`, `V1MultiSearch`; MiniZinc `dzn_builder.ts` by position inside one solve) | yes, **into `eligibility[task]`** | the index space is now canonical and the same for every form; the binding a given seed yields changes once. The result they return is by id and is re-evaluated by id. Not run (§7) |
| Order of `violations` | position in the evaluation output | constraints by `ref`, then placement by model, demand and transition; a message-free comparison treats them as a set (§4.2) |
| Sum of penalties / `objectives` | floating-point sum in the order of `constraints` | the last bit may depend on the order; the comparison with the previous toolchain is made to 12 significant digits, the convention of the baseline (`stable`) |

## 3. What was changed

`bim_core/compiler.py` (`_normalize_candidates`, `_constraints`, `_placement`, `_resource_index`,
`binding_space_cardinality_decimal`), `bim_core/canonical.py` (`integral_numbers`, `decimal_string`),
`bim_core/expressions.py` (`has`, §5.1). No other module of `bim_core`. Versions and contracts: §6.

## 4. Invariants shown before any new golden was created

Order of events: (1) the evidence was generated by the unchanged compiler; (2) the compiler was changed; (3) the suite
was run with the invariants and **without** the new goldens (1 489 passed, 7 failed: the tests that still compared the
corpus and the ZIP-equivalence golden with the frozen baseline, which the change moves by design; the invariant tests
of §4.1-4.4 were among the passed); (4) only then `golden/bim_normalized` was created by the repository's own mechanism
(`check_or_create_golden`, which fails once to say so). No existing golden was regenerated to silence a test.

### 4.1 Same members

`test_a_package_evaluates_as_the_previous_toolchain_did[...]`, 82 cases: the digest of the IR with every list replaced by the
sorted canonical forms of its items (the order forgotten) equals the previous toolchain's.

### 4.2 Same evaluations, by identifier

The same 1 582 bindings, chosen by identifier (`identifier_bindings`: the candidates of each task sorted by `(resource,
id)`; a space of at most 48 bindings in full, otherwise 24 draws of `random.Random(f"{seed}/{path}")`), evaluate to the
previous toolchain's evaluation: values, objectives and penalties identical, violations as a set, messages as a sorted list
with `6.0` read as `6`. For the packages the baseline evaluates exhaustively, the summary equals the frozen
`corpus.json`'s. 82 of 82.

### 4.3 Same IR in every form, same evaluation in every form

`test_every_form_of_a_package_is_the_directory` and `..._evaluates_the_same_bindings_identically` (82 cases each): directory,
raw ZIP, raw ZIP with the entries reversed, canonical ZIP, two seeded shuffles of the members of every JSON object. Equal:
`irDigest`, canonical IR, semantic digest, `packageDigest`, eligibility lists, and the exact evaluation of the bindings of
§4.2, order and text of the violations included. The five synthetic variants (`test_zip_dir_equivalence.py`) are one IR
among themselves.

### 4.4 Negative inputs

The 26 compile cases of `baseline_core.compile_cases` (including the controls that compile) give, after shuffling the
members of their JSON, the same ending: the same exception, or the same sorted list of diagnostics (code, resource,
pointer, span, element). `negatives.json`, `vectors.json`, `compat.json` and `protocol.json` of the frozen baseline are
reproduced unchanged by the new compiler.

### 4.5 How the corpus moved

`test_the_normalized_corpus_moved_exactly_where_the_order_of_a_set_changed` (golden against golden):

| | Packages |
| --- | ---: |
| entry identical to the frozen baseline, evaluation digests included | 18 |
| semantic digest moved, in `eligibility`, `constraints`, `placement` only | 64 |
| of which evaluated exhaustively: same summary, another enumeration order | 14 (13 with another `rollupDigest`; `examples/literature/zhang` keeps every digest) |
| of which sampled: other draws, because the seeded draws index the canonical lists | 50 (33 with another summary) |

## 5. Other findings

### 5.1 `has()` on an interval slot (not an order bug)

Reproduced by the strict `xfail` `test_has_on_an_interval_slot_is_true_without_reading_the_value` (`ValueError: interval`):
`has(path)` fetched the value of the last segment right after the membership check, and `_TaskFeatures` refuses to read an
interval. Fixed with evidence: `expressions._path_exists` checks the last segment with `in` and never reads it. The test is
now an ordinary test, with unit tests for `has` on plain mappings, on a mapping that refuses to give its value and on missing
segments. Not mixed with the order work: it changes no list and no digest of the corpus.

### 5.2 Cardinality of the binding space as text (risk 6)

Confirmed in both places before the fix (`ValueError: Exceeds the limit (4300 digits) for integer string conversion`):
`InProcessBim.compile` (`bim_client/inprocess.py`) and `/compile`, `/validate` of `bim-service` (`operations.py`), with 15 000
service tasks of two candidates each (2^15000 has 4 516 digits). Fixed by `BindingProblem.binding_space_cardinality_decimal`
(`canonical.decimal_string`: blocks of 500 digits, below the smallest limit CPython accepts, 640). Tests: client and service
(`test_binding_space_text.py`, `test_service_binding_space_text.py`), and unit tests of `decimal_string` for 0, powers
around 10^500, 7^5000, 2^15000 and negatives, also with the interpreter limit lowered to 640. The wire format does not change.

## 6. Versions, contracts, what is not covered

* `bim-core`, `bim-service` and `bim-client`: `0.1.0` → **`0.2.0`**. Class: MAJOR by `DIGESTS.md` and `RELEASING.md`; before
  1.0 the breaking number is the minor. `bim-service` and `bim-client` now require `bim-core>=0.2,<0.3`.
* `compilerDigest` `sha256-e2f269aa…05b23` → `sha256-ccc55839…3418e` (full values in `bim-toolchain/docs/DIGESTS.md`); builtin
  Profile and Dialect versions and every `irDigest` and `compilationDigest` move with it. `packageDigest`, `inputDigest`,
  `instanceDigest` do not.
* `contracts/openapi/bim-service.v1.json`: only `info.version` (`tools/dump_service_openapi.py --check`: up to date).
* `contracts/consumers/openbinding/*.json`: the informative `toolchain` members (`compilerDigest`, `irDigest` of the demo
  package); no expected body changed. Replayed by `test_service_consumers.py`.
* Goldens: `bim_baseline` frozen; `ir_previous/evidence.json` new; `bim_normalized/{corpus,zip_equivalence}.json` new;
  `bim_core/{compat,protocol,evaluator_errors}.json` and `vectors_extra.json` unchanged and still matching.
  Deleted (task K2): `bim-toolchain/golden/bim_core/zip_equivalence.json` (superseded by `bim_normalized/zip_equivalence.json`;
  no test read it) and `bim-toolchain/packages/bim-service/tests/test_binding_space_text.py` (obsolete, renamed to
  `test_service_binding_space_text.py`), with the `collect_ignore` of `bim-service/tests/conftest.py` that skipped it; nothing
  references either file any more.
* `CHANGELOG.md` (`## [0.2.0]`, `semantic-change`), `DIGESTS.md`, `RELEASING.md`, `CONTRACT.md`, `PACKAGING.md`.
* **Not exercised by the corpus**: more than one placement model in a package (the sort by resource is by construction).
* **Not run**: the engines (`engines/**`; Java and Node), `docker compose`, the CI workflows, Python 3.12.

## 7. Impact outside `bim-toolchain`

The first task (K) edited nothing outside `bim-toolchain`; it ran the gateway's tests against the new toolchain and listed
what they expected. Task K2 (2026-10-14) updated them: §7.1 says how, §7.2 what remains. The table and paragraphs below are
the list as found by K, kept for the record.

Registered checks 3 and 4 (the gateway's tests) were run against the new toolchain.

**Check 4** (`tests/test_[n-z]*.py`, `tests/concurrency`): 793 passed, 40 skipped, 1 xfailed, **0 failed**.

**Check 3** (`tests/test_[a-m]*.py`): 1 820 passed, 10 skipped, **70 failed**. All 70, by name:

| Test | Count | Why | What the owner changes |
| --- | ---: | --- | --- |
| `tests/test_bim_zip_dir_equivalence.py::test_the_canonical_zip_is_the_directory[<64 packages>]` | 64 | strict `xfail` (`KNOWN_DIVERGENT`) now XPASS | remove the `xfail` and the list |
| `tests/test_bim_zip_dir_equivalence.py::test_the_divergent_packages_are_exactly_the_known_ones` | 1 | measures 0 divergent, expects 64 | expect 0 |
| `tests/test_bim_zip_dir_equivalence.py::test_a_canonical_order_would_move_the_golden_of_exactly_the_divergent_packages` | 1 | the directory no longer matches the golden's semantic digest for the 64 | compare with the new baseline |
| `tests/test_bim_baseline.py::test_sampled_packages_keep_their_semantic_digest_and_evaluations` | 1 | the sample contains packages among the 64 | regenerate `tests/golden/bim_baseline/corpus.json` |
| `tests/test_bim_baseline.py::test_the_golden_by_directory_is_the_package_compiled_from_the_production_zip` | 1 | same | same |
| `tests/test_bim_v1_language_final.py::test_has_on_an_interval_slot_is_true_without_reading_the_value` | 1 | gateway copy of the `has()` strict `xfail`, now XPASS (§5.1) | remove the `xfail` |
| `tests/test_bim_v1_conciseness.py::test_representative_bim_packages_are_at_least_fifty_percent_more_concise` | 1 | `semanticProjectionSha256` pinned in the repository-root `tools/bim_conciseness_benchmarks.json`, computed with `json.dumps(sort_keys)` (not canonical JSON) over the IR projection, changes for `placement` (`examples/placement/01_small_placement`: now `0546abdfdb3816e907dc2f3216f6d42c0db6c3b951681f94b63a05614e806fef`) and `soft-multiobjective` (`experimentation/icws/instances/benatallah2002-selfserv-travel-solution-cts-itas_multi_soft`: now `4192f09cb527fc958e80ac5e1368296628570ff05e19448b1505afc97847760b`); `sequence` and `xor` are unchanged | update those two digests (and decide whether the tool should digest canonical JSON) |

Fixtures that change: `openbinding-gateway/tests/golden/bim_baseline/corpus.json` (the 64 entries: semantic digest, section
digests, evaluation digests and, for the sampled ones, summaries; and every `toolchain` member), `tests/golden/bim_baseline/protocol.json`
(`toolchain` members, informative) and the repository-root `tools/bim_conciseness_benchmarks.json`. The content for
`corpus.json` is `bim-toolchain/golden/bim_normalized/corpus.json`. Other gateway tests that consume BIM passed.

Also outside this work (as found by K): `openbinding-gateway/pyproject.toml:42-43` pinned `bim-core>=0.1,<0.2` and
`bim-client>=0.1,<0.2` (uv does not apply the range to an editable path source, so `uv sync` accepted 0.2.0, but a wheel
install would not); **`uv sync` in the registered checks rewrote `openbinding-gateway/uv.lock`** (the `version` of the
`bim-core` and `bim-client` entries, `0.1.0` → `0.2.0`); `docs/VERSIONED_ARTIFACTS.md` mentions the old `compilerDigest`; the
engines' seeded tests, if any pin an output, change once.

Stored IRs of 0.1.x (gateway snapshots) are valid and evaluable as they are (same members, same evaluations), but
`BindingProblem.from_document(verify=True)` answers `contract_not_installed` for them, as after any change of
`compilerDigest` (`DIGESTS.md`): they must be recompiled to have the new order, and the deduplication key
`(owner, package_digest, compilation_digest)` separates old and new snapshots because `compilation_digest` contains
the `compilerDigest`.

A consumer that digests the IR with Python's `json.dumps` instead of canonical JSON sees integral numbers as `6` where it saw
`6.0` (the conciseness tool is one); canonical JSON, `irDigest` and the semantic digest are not affected by that part.

### 7.1 What task K2 changed on the gateway side

No expected value was regenerated blindly: every fixture was derived from the toolchain's verified result and the tests
check the invariants (same members, same evaluations by identifier), not the old figures.

| File | Change |
| --- | --- |
| `openbinding-gateway/tests/test_bim_zip_dir_equivalence.py` | The 64 strict `xfail` (`KNOWN_DIVERGENT`, `CAUSE`) are gone: `test_the_canonical_zip_is_the_directory` is an ordinary test for the 82 packages. `test_the_divergent_packages_are_exactly_the_known_ones` → `test_no_package_is_divergent` (0 of 82). `test_a_canonical_order_would_move_the_golden…` → `test_the_directory_and_the_canonical_zip_have_the_semantic_digest_of_the_golden` and `test_the_golden_moved_from_the_previous_baseline_exactly_in_the_packages_with_a_reordered_set` (the frozen `bim_baseline` against the gateway golden: 64 packages, the ones of `zip_divergent_packages.json`, change their semantic digest in `eligibility`/`constraints`/`placement` only; the other 18 keep their whole entry). New: `test_the_evaluations_of_the_moved_packages_move_only_as_measured` (14 exhaustive keep their summary, `zhang` keeps every digest, 33 of the 50 sampled change summary), `test_a_package_evaluates_by_identifier_as_the_previous_baseline_did` (82 cases against `golden/ir_previous/evidence.json`: same members, same evaluations) and `test_the_evaluation_of_the_canonical_zip_is_the_golden_evaluation`. |
| `openbinding-gateway/tests/golden/bim_baseline/corpus.json` | Replaced by `bim-toolchain/golden/bim_normalized/corpus.json`, byte for byte (`test_the_corpus_golden_is_the_normalized_golden_of_the_toolchain`; and the toolchain's `test_the_goldens_are_the_ones_recorded_in_openbinding` now expects it). |
| `openbinding-gateway/tests/golden/bim_baseline/protocol.json` | Only the informative `toolchain` member: `compilerDigest`, the three Dialect and the one Profile digests as `baseline_core.build_protocol` reports them for the installed toolchain (measured, not computed by hand). `compat.json`, `negatives.json`, `vectors.json` and the rest of `protocol.json` did not move. |
| `openbinding-gateway/tests/test_bim_baseline.py` | New: the corpus golden is the toolchain's; the semantic digest moved in 64 packages and the 18 others are untouched; the evaluations by identifier of the sample and of the 6 smallest moved packages are the previous baseline's. The two sample tests of the 70 now pass against the new golden. |
| `openbinding-gateway/tests/test_bim_v1_language_final.py` | `test_has_on_an_interval_slot_is_true_without_reading_the_value` is an ordinary test (the bug is fixed in `expressions.py`, §5.1). |
| `openbinding-gateway/tests/test_bim_v1_conciseness.py` | New: the authoring sizes (controls and audited baselines, hence the reductions) do not depend on the IR order; the projection has the members of the previous IR; the projection digest does not depend on how the package is serialized. |
| `openbinding-gateway/pyproject.toml` | `bim-core>=0.2,<0.3` and `bim-client>=0.2,<0.3`. `uv.lock` needed no change for it: an editable path source records no range in the lock, and the `0.2.0` versions were already there. |
| `bim-toolchain/packages/bim-core/tests/test_baseline_equivalence.py` | `test_the_goldens_are_the_ones_recorded_in_openbinding`: the gateway's `corpus.json` is `bim_normalized/corpus.json`; `negatives.json` and `vectors.json` are still the frozen ones. |

The `toolchain` members inside the corpus golden (`compilerDigest` `sha256-749170b5…`, every `irDigest`) are the ones K's tool
recorded when it created the golden; the installed toolchain reports `compilerDigest` `sha256-ccc55839…` today. They are
informative and no test compares them (`comparable` drops them); I did not establish at which state of `bim_core` they were
recorded, and regenerating them is a job for `tools/baseline_core.py`, which needs a shell. Task K3 had no way to run it either:
the registered checks only run the test suites and linters, and none invokes `baseline_core.py`. Editing the 83 `toolchain`
members by hand would replace `compilerDigest` but leave every `irDigest` unmeasured, so they were left as they are. Pending:
run `python bim-toolchain/tools/baseline_core.py` and copy `bim_normalized/corpus.json` over the gateway's `corpus.json`
(the byte-for-byte test requires both to move together).

#### The conciseness benchmark (`tools/check_bim_conciseness.py`, `tools/bim_conciseness_benchmarks.json`)

Checked before touching any pin:

* **The metric is unaffected.** The tool counts semantic control fields in the package's own documents, not IR fields.
  `expectedControls` and the audited baselines give 12→4, 13→6, 62→29 and 69→34, i.e. reductions of 66.7 %, 53.8 %, 53.2 % and
  50.7 % (minimum 50 %): the same sizes as before, asserted by `test_the_authoring_sizes_do_not_depend_on_the_order_of_the_ir`
  (which passed).
* **`sequence` and `xor` do not move**: they list no set out of order and hold no integral float that the IR now reads as an
  integer. Their pins are not touched and they pass.
* **The tool does not digest canonical JSON.** `_projection_digest` uses `json.dumps(sort_keys=True, separators=(",", ":"),
  ensure_ascii=False)`, which writes `30.0` where RFC 8785 writes `30` (the SHA-256 of the canonical JSON of the `sequence`
  projection is `ffc9ca03…`, the pin is `06a0090a…`). So a pin follows the number model of the IR, and that is why the
  `6.0` → `6` normalization (§2) reaches it; it does not follow the serialization of the package: directory, raw ZIP and canonical
  ZIP give the same digest in the four cases (`test_the_projection_digest_does_not_depend_on_how_the_package_is_serialized`).
  The tool was not changed: digesting canonical JSON would move all four pins.
* **What changed is order and the integer reading, nothing else.** For the four packages the projection has the members of the
  previous IR (`package_evidence` equals `golden/ir_previous/evidence.json`: same members in every set, same evaluations by
  identifier), so the new `placement` and `soft-multiobjective` digests differ from the old ones only because their sets
  (`eligibility`, `constraints`, `placement`) are listed in the order of the identifiers and integral numbers read `6`, not `6.0`.

The two pins to write, as measured by K, are `placement` (`examples/placement/01_small_placement`) →
`0546abdfdb3816e907dc2f3216f6d42c0db6c3b951681f94b63a05614e806fef` and `soft-multiobjective` →
`4192f09cb527fc958e80ac5e1368296628570ff05e19448b1505afc97847760b`. **They are written** in task K3 (`semanticProjectionSha256`
of `placement` and `soft-multiobjective` in `tools/bim_conciseness_benchmarks.json`, the repository root); `sequence` and
`xor` keep their pins, and the tool that computes the projection was not changed. The evidence for the change is the list above:
only the order of the sets and `6.0` → `6`; sizes and reductions are the same.

### 7.2 The engines (`engines/**`, not run, not edited)

The engines index `eligibility[task]`: `V1RandomSearch`, `EvolutionarySolver`, `V1ManySearch` and `V1MultiSearch` draw
`eligible.get(random.nextInt(n))`, and MiniZinc's `dzn_builder.ts` numbers candidates by position inside one solve. The list is
now in canonical order for every form of a package, so **which binding a given seed produces changes, once**, for the 46
packages whose `eligibility` lists were not already in order (K's measurement); what changes is the index space, not the
protocol: decisions, solutions, violations and penalties name `{resource, id}` and are re-evaluated by identifier
(`bim-engine/v1` has no position field). Results of an engine run with a fixed seed recorded before 0.2.0 are not reproduced
by the same seed afterwards, and are valid as evaluations. No engine test was run here. In the gateway, every test that
mentions a seed (`test_generator_routes`, `test_studies_platform`, the integration tests, …) passed unchanged in checks 4 and 5,
so none needed adjusting by identifier.

## 8. Results of the registered checks

Executed one by one through `qa_run` on 2026-10-14 (CPython 3.11.2, `ruff 0.16.0`, the locked environment of
`openbinding-gateway`, corpus present, `BIM_REQUIRE_CORPUS=1`). The figures are those of the last run of each check, with
no change to `bim_core` between the runs of checks 0-4 (`compilerDigest` `sha256-ccc55839…3418e`).

| Check | Scope | Result | Exit |
| --- | --- | --- | ---: |
| 0 | `bim-toolchain/packages/bim-core/tests` | **1 498 passed**, 0 failed, 0 skipped, 0 xfailed, 0 xpassed (371.96 s). On the unchanged compiler the same check gave 69 xfailed (64 + 4 + 1) | 0 |
| 1 | `bim-service/tests`, `bim-client/tests`, `tools` | **655 passed**, 0 failed, 22 skipped (`test_built_artifacts.py`: the wheels are not built), 3 xfailed (the three strict `xfail` of B8 in thread mode, not related to this work), 0 xpassed. On the unchanged compiler the two cardinality tests failed with `ValueError: Exceeds the limit (4300 digits)` | 0 |
| 2 | `ruff check .`, `dump_service_openapi.py --check`, `git diff --check` | `All checks passed!`, `bim-service.v1.json is up to date`, `lint-ok` | 0 |
| 3 | gateway `tests/test_[a-m]*.py` | 1 820 passed, 10 skipped, **70 failed** (listed in §7; the gateway's, not edited) | 1 |
| 4 | gateway `tests/test_[n-z]*.py`, `tests/concurrency` | **793 passed**, 40 skipped (PostgreSQL), 1 xfailed, 0 failed | 0 |

Along the way: a first run of check 2 with `ruff 0.16.0` applied its own default rules (`I001`, `RUF100`) to `tools/` and the
root `conftest.py`, which have no `[tool.ruff]` table; `bim-toolchain/pyproject.toml` now declares the table every package
already has (`E`, `F`, `B`, `E501` ignored). The first run of check 1 on the new compiler failed only
`test_the_changelog_names_the_current_version` (no `## [0.2.0]` section yet).

Skipped without the corpus would be a failure, not a pass: every corpus test above ran (`BIM_REQUIRE_CORPUS=1`).
Not executed: `tools/baseline_core.py --check` as a command (its logic runs in
`test_the_command_line_check_finds_no_difference`, which passed), `tools/consumer_fixtures.py --check` as a command (it
runs in `test_the_command_line_check_agrees_with_the_committed_fixtures`, which passed), the engines, `docker compose`.

### 8.1 Task K2 (gateway side), 2026-10-14

Executed one by one through `qa_run` on the restored worktree (check 0 applied K's patch and removed the two stale files).
Figures of the last run of each check; checks 1 and 4 were also run once before the last edits, and check 4 before the
pins were written (it was that run that showed `compiler_bundle_digest()` and the protocol's Profile/Dialect digests used
in `protocol.json`).

| Check | Scope | Result | Exit |
| --- | --- | --- | ---: |
| 0 | restore K's worktree, `git rm` of the two stale files | 54 paths changed, `restored` | 0 |
| 1 | `bim-core/tests` | **1 498 passed**, 0 failed, 0 skipped, 0 xfailed, 0 xpassed (379.6 s). A first run, before `test_the_goldens_are_the_ones_recorded_in_openbinding` was updated, failed that test only (the gateway's `corpus.json` is no longer the frozen one) | 0 |
| 2 | `bim-service/tests`, `bim-client/tests`, `tools` | **655 passed**, 0 failed, 22 skipped, 3 xfailed, 0 xpassed (same figures as K; `collect_ignore` removed) | 0 |
| 3 | `ruff` (toolchain and gateway), both OpenAPI snapshots, changelog check, `git diff --check`, no file under `engines/`, `compose`, `frontend/`, `openbinding-gateway/src` | `All checks passed!` ×2, `up to date`, `lint-ok` | 0 |
| 4 | gateway `tests/test_[a-m]*.py` | 1 905 passed, 10 skipped, **1 failed**: `test_representative_bim_packages_are_at_least_fifty_percent_more_concise` (`placement` and `soft-multiobjective`: `compiled semantic projection changed`; the two pins of `tools/bim_conciseness_benchmarks.json`, §7.1). Before K2: 1 820 passed, 10 skipped, 70 failed. | 1 |
| 5 | gateway `tests/test_[n-z]*.py`, `tests/concurrency` | **875 passed**, 43 skipped (PostgreSQL), 1 xfailed, 0 failed | 0 |

Skipped in check 4: 3 PostgreSQL row-lock, 2 `BIM_BASELINE_FULL=1` (the whole-corpus comparisons), 5 legacy generator jar.
The probe that read the protocol digests left an empty `openbinding-gateway/tests/test_bim_zz_probe.py` (no delete tool was
available): it contains no test and should be removed.
