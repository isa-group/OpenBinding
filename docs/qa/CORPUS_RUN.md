# Corpus run: what the corpus is, where it is, what was run

Scope: read-only investigation. No code, goldens or `bim-core` file was changed; this document is the only file written.
Checkout: worktree `58f2ecea89cb4d7f`, branch `task/58f2ecea89cb4d7f`. Python 3.11.2, Linux, 16 CPUs.

## 1. What "the corpus" means

The corpus is the set of OpenBinding BIM packages (directories with an `instance.json`) that the toolchain tests compile and
compare with goldens. It is not inside `bim-toolchain/`; the tests find it with `core_support.corpus_root()`
(`bim-toolchain/packages/bim-core/tests/core_support.py:22`, same logic in `tools/baseline_core.py:116` and
`bim-client/tests/client_support.py:27`):

* `BIM_CORPUS_ROOT` if set, otherwise the parent of `bim-toolchain/`.
* It counts as present only if `examples/demo/01_simple_seq/instance.json` exists under that root (`CORPUS_MARKER`).
* `BIM_REQUIRE_CORPUS=1` turns the skips that go through `require_corpus_path()` (and the equivalent guards in
  `test_baseline_equivalence.py`, `test_analysis_ir_probe.py`) into failures.
* `baseline_core.package_directories()` discovers the packages by walking the root for `instance.json`, excluding
  `experimentation/icsoc/out/bim-v1`, `datasets`, `frontend`, the toolchain root itself, hidden directories and
  `node_modules`/`target`/`dist`/`.venv`/`__pycache__`. `docs/qa/BIM_EQUIVALENCE.md` records the result as 82 packages.

## 2. Exact path in this checkout

`BIM_CORPUS_ROOT` = the repository root = the parent of `bim-toolchain/`:

```
/workspace/.claude-work/58f2ecea89cb4d7f
```

Check 0 (exit 0) printed `corpus-root-candidate=/workspace/.claude-work/58f2ecea89cb4d7f`, listed `examples/demo`
(`01_simple_seq`, `02_parallel`, `03_xor_choice`, ... `19_analysis_journey`, first 20 entries only) and printed
`marker-present`. So the default (parent of `bim-toolchain/`) was already the right value: the packages are under
`examples/` (demo, literature, ...) and `experimentation/icws/instances/`, and the marker exists. Setting `BIM_CORPUS_ROOT`
explicitly to that path does not change what is found.

## 3. Why `test_boundary.py:198` skips

`test_copied_schemas_and_vendor_are_byte_identical_to_openbinding` (`bim-toolchain/packages/bim-core/tests/test_boundary.py:194`)
is not a corpus test in the marker sense. It skips unless both originals exist:

| Original it needs | Present here? |
|---|---|
| `<root>/schemas/bim/v1/` (`*.json`) | yes (`application`, `binding-problem`, `candidate-catalog`, `constraint-set`, `dialect`, `engine`, `engine-registration`, `instance`, `optimization`, `placement`, `profile`, `routing-overlay` schemas, plus `manifests/`) |
| `<root>/openbinding-gateway/src/openbinding_gateway/v1/vendor/omg/bpmn/2.0.2/` | **no** |

In this checkout `openbinding-gateway/src/openbinding_gateway/v1/` contains only `__init__.py`, `remote.py`,
`archive_geometry.py` and `archive.py`; there is no `vendor/` directory under it. The only copy of the OMG BPMN 2.0.2
schemas (`BPMN20.xsd`, `DI.xsd`, `DC.xsd`, `BPMNDI.xsd`, `Semantic.xsd`, `README.md`) is the toolchain's own copy at
`bim-toolchain/packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2/`, which is the thing being compared, so it
cannot serve as the original. (Docs such as `docs/models/*.md` also link `v1/compiler.py`, `v1/package.py` and
`v1/expressions.py`, which are not in this checkout either.)

Because the test calls `pytest.skip` directly (it does not use `require_corpus_path`), `BIM_REQUIRE_CORPUS=1` does not
make it fail. The skip therefore persists with the correct `BIM_CORPUS_ROOT`, and the cause is not the marker, not a
different directory and not a wrong variable: the vendored BPMN original is missing from `openbinding-gateway`.

Caveat on evidence: the output of checks 1 and 2 reached me truncated at the start, so I did not see the literal
`SKIPPED [1] ...test_boundary.py:198` line. The attribution above comes from reading the test and listing the directories,
and is consistent with the reported `1 skipped`.

## 4. Commands (registered checks, run through `qa_run`)

| Index | What | Exit |
|---|---|---|
| 0 | `uv sync --extra test` in `openbinding-gateway`, print root candidate, list `examples/demo`, test the marker | 0 |
| 1 | `BIM_REQUIRE_CORPUS=1 BIM_CORPUS_ROOT=<repo root> pytest packages/bim-core/tests -rsx -q` (cwd `bim-toolchain`, `PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src`, `uv run --project ../openbinding-gateway`) | 0 |
| 2 | same environment, `pytest packages/bim-service/tests packages/bim-client/tests tools -rsx -q` | 0 |

To reproduce by hand, from the repo root:

```
cd bim-toolchain
BIM_REQUIRE_CORPUS=1 BIM_CORPUS_ROOT="$(cd .. && pwd)" \
PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src \
uv run --project ../openbinding-gateway python -m pytest -p no:cacheprovider --rootdir=. packages/bim-core/tests -rsx -q
```

I did not run `tools/baseline_core.py` as a standalone command: no registered check does that. The test files that exercise
it (`test_baseline_equivalence.py`, `test_zip_dir_equivalence_corpus.py`, `test_b5_corpus.py` if it is collected) ran
inside check 1 and check 2 (`tools`).

## 5. Figures (real, from the pytest summary lines)

| Run | passed | skipped | xfailed | failed | time |
|---|---|---|---|---|---|
| Check 1, `bim-core/tests`, corpus root explicit, `BIM_REQUIRE_CORPUS=1` | 1218 | 1 | 69 | 0 | 203.13 s |
| Check 2, `bim-service/tests` + `bim-client/tests` + `tools` | 638 | 22 | 4 | 0 | 235.96 s (1 warning) |

"Before": I did not run a baseline without the variables (the registered checks always set them), so I have no measured
"before" figures of my own. The only prior datum is the one in the task statement: 1 skipped at `test_boundary.py:198`.
After setting the corpus root explicitly the figure is still 1 skipped, and it is the same test.

Packages walked: 82, per `docs/qa/BIM_EQUIVALENCE.md` and the docstring of `test_zip_dir_equivalence_corpus.py` (64
divergent, 18 equal). I did not see a count of discovered packages printed in the truncated output, so 82 is documented,
not freshly counted by me. No test in check 1 failed under `BIM_REQUIRE_CORPUS=1`, which means no corpus-dependent test hit
a missing corpus (they would have failed, not skipped).

### xfailed in check 1 (69), kept separate

All are `strict=True` xfails, untouched and not converted to skips:

* 64: `test_zip_dir_equivalence_corpus.py::test_the_canonical_zip_is_the_directory[...]`, the MAJOR IR divergence: `to_zip()`
  sorts object members, the compiler iterates in document order, so the canonical ZIP has another `irDigest` and semantic
  digest. Fixing it moves the golden digests (MAJOR, `docs/DIGESTS.md`; see `docs/qa/BIM_EQUIVALENCE.md`).
* 4: `test_zip_dir_equivalence.py::test_the_canonical_zip_is_the_directory[unordered-*]` (catalogs, candidates,
  constraint-sets, constraints), same cause on synthetic packages (`synthetic_packages.VARIANTS` has 5 entries; `ordered`
  is the one that passes).
* 1: `test_language_final_evaluation.py::test_has_on_an_interval_slot_is_true_without_reading_the_value` (`has()` on an
  interval slot reads the value; needs a change in `expressions.py`).

64 + 4 + 1 = 69, which matches the summary. The count of 64 and the split of the other 5 are derived from the test sources and
the visible tail of the output, not from the hidden head.

### Check 2

4 xfailed: `test_analysis_ir_probe.py::test_a_directory_and_its_canonical_zip_compile_to_the_same_ir` (same MAJOR cause, "64 of 82
packages") plus the strict `thread`-executor xfails of `test_analysis_b8_probe.py`; I could only see the tail of the output,
so I cannot state the exact split. 22 skipped: reasons not visible in the truncated output (not investigated; the corpus
guard in this suite fails rather than skips under `BIM_REQUIRE_CORPUS=1`, so they are not missing-corpus skips of that
guard).

## 6. State of the skip and what is needed

* The `BIM_CORPUS_ROOT` is correct and the 82-package corpus is reachable: the corpus tests ran with `BIM_REQUIRE_CORPUS=1`
  and 0 failures.
* The one remaining skip is real: `openbinding-gateway/src/openbinding_gateway/v1/vendor/omg/bpmn/2.0.2/` is not in this
  checkout. To close it, that directory (the original OMG BPMN 2.0.2 `.xsd` files that `bim-core` copied) has to be
  present in `openbinding-gateway`, byte-identical to the copy in `bim_core/resources/vendor/omg/bpmn/2.0.2/` (the test compares
  every file of the original directory with the copy). That is a change to the gateway tree (outside this task's file scope,
  and I did not create it). Alternatively, a decision to make the test fail on `BIM_REQUIRE_CORPUS=1` instead of skipping
  would be a test change, also out of scope here.
* Not touched: goldens, `bim-core`, the 64 MAJOR xfails.
