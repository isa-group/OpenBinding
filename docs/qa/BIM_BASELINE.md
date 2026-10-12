# BIM semantic baseline (phase 0-A)

The extraction of BIM into its own repository changes `compilerDigest`, `irDigest` and the bundled
versions. Those digests therefore cannot show that the *meaning* of BIM survived. This baseline pins
the meaning instead, before anything moves: a semantic digest per package, the output of the canonical
evaluator, Engine mode compatibility, diagnostics of negative cases, result re-evaluation vectors and
the protocol/schema digests.

Files:

| File | Purpose |
| --- | --- |
| `tools/bim_baseline.py` | Deterministic generator (and the functions the test reuses). |
| `openbinding-gateway/tests/golden/bim_baseline/*.json` | The goldens (below). |
| `openbinding-gateway/tests/test_bim_baseline.py` | Regenerates a sample and compares it with the goldens. |

## What is captured

All files are JSON with sorted keys, one-space indent, LF line endings and no timestamps
(`tools/bim_baseline.py::dump`).

- **`corpus.json`** - one entry per package of the corpus, discovered with
  `tools/check_bim_corpus.py::package_directories` (`examples/**`, `experimentation/icws/instances/**`,
  `engines/minizinc-csp/tests/fixtures/**`; 82 packages).
  - `semanticDigest`: digest of `spec` without `profile`, `dialects`, `instance` and `sourceMap`, the
    definition pinned by `GOLDEN_SEMANTIC_SPEC_DIGEST` in `tests/test_b5_golden.py`.
    `sectionDigests` (16 hex characters each) says which top-level section moved when it changes.
  - `tasks`, `candidates`, `bindingSpace` (`cardinality` as a string, `log10` rounded to 9 decimals,
    candidates per service task).
  - `evaluation`, produced with `BindingProblem.validate_binding` and `BindingProblem.evaluate`:
    - `|S| <= 2000`: **every** binding, in the order of the canonical eligibility lists
      (`mode: exhaustive`).
    - otherwise 16 bindings drawn with `random.Random(20261012)` (`mode: sample`, fresh generator per
      package, so a package's draw does not depend on the rest of the corpus).
    - `rollupDigest` is the digest of the full per-binding digests (digest of binding plus outcome, or of
      the exception it raises). To keep the file small, per-binding digests are stored as 16-hex-character
      prefixes in `bindingDigests` when there are at most 64 bindings, and as prefixes of block digests
      (`blockDigests`, 64 bindings per block) otherwise.
    - `summary`: counts and min/max of features, criterion losses, penalty and score; hard/soft violation
      counts per constraint; exception types.
- **`compat.json`** - for every package and each of the 5 manifests in `schemas/bim/v1/manifests/`, the result
  of `services.engines.mode_compatibility` for every mode: `compatible`, a list of
  `code:category[:values]` strings and the digest of the complete diagnostics.
- **`negatives.json`** - diagnostics of negative cases, either mirrored from `test_v1_language`,
  `test_b5_open_ranges` and `test_b5_corpus` or constructed in memory from `examples/demo/01_simple_seq`:
  compile errors (`code`, `resource`, `pointer`, span/BPMN element/`irPath` when present, not the message,
  which embeds jsonschema wording), package errors (ZIP traversal, ...), expression errors with spans, and
  `validate_binding` rejections. Controls that must compile are included.
- **`vectors.json`** - 10 synthetic Engine answers on the demo problem (OPTIMAL, FEASIBLE, INFEASIBLE,
  UNKNOWN, binding outside eligibility, miscomputed objective, invalid shape, ...) with the current output
  of `services.execution.reevaluate_result` and the verdict of `v1.remote._validate_result`.
- **`protocol.json`** - `protocolDigest`, the digest of the Engine OpenAPI contract (bytes and document),
  of each `schemas/bim/v1/*.schema.json` (bytes), of each Engine manifest (canonical digest) and of the
  vendored OMG BPMN schemas.

## What is not captured

- **`irDigest` and `compilerDigest`** are stored, but only in `toolchain` fields (per package, at the top of
  `corpus.json` and in `protocol.json`, together with the installed profile/dialect manifest digests, which
  contain the compiler digest). `tools/bim_baseline.py::comparable` removes every `toolchain` key and the
  test never compares them. Expect them to change.
- Candidate ids, provider names and any dataset values: only digests and numeric summaries derived from
  evaluations are stored, so no content of datasets with an unverified licence is copied.
- Diagnostic *messages* of compile errors (codes and locations are compared). Messages of non-compile
  errors (`PackageError`, `ExpressionError`, `ValueError` of the evaluator) are stored.
- The last bits of floating point numbers. Every float produced by an evaluation (and by
  `reevaluate_result`) goes through `tools/bim_baseline.py::stable` before it is digested or summarized:
  `float(format(x, ".12g"))`, i.e. 12 significant digits, written by `json` with the shortest `repr`. The
  per-binding digests, `rollupDigest`, `blockDigests` and the min/max in `summary` therefore do not depend
  on libm/platform builds or summation order beyond the 12th digit. `bindingSpace.log10` is rounded to 9
  decimals. A change that survives this rounding is a change of meaning.

## Recorded goldens

Generated by `tools/bim_baseline.py` on 2026-10-12 (CPython 3.11.2, locked environment of
`openbinding-gateway`). **82 packages**, all compiled: 31 evaluated exhaustively (`|S| <= 2000`) and 51
sampled (16 seeded draws). Two consecutive generations give identical bytes (`diff -r` clean). No golden
contains a `compilerDigest`/`irDigest` outside a `toolchain` key.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `corpus.json` | 222382 | `0ca465a0230c96aa4e44bba54cc73dba9d0a1c98adb4325b9699d194cdd9bfec` |
| `negatives.json` | 11423 | `b7247d241d21c7086e716c4cfeea92af0785b55fba02f0b0ef1f03ed0f0e4194` |
| `compat.json` | 144687 | `8f6f3ac94d1bf59235a328644965c3f9df512010469caae836f5a0aec21759a8` |
| `vectors.json` | 14929 | `91d283706f6801245758e28a5968958056fe372f4e53e33ef0e48b28eecaaedb` |
| `protocol.json` | 3233 | `700f211018835c44352535ebfebeb3c71dbb1ad47fa4c48048623a963ca03ccc` |
| **Total** | **396654** | (budget: < 1.5 MB) |

The tool prints the same byte counts and SHA-256 values when it runs. The hashes cover the `toolchain`
fields too, so they are expected to change once the toolchain moves; compare with `comparable` (the test
does) rather than with these hashes.

## Regenerate

From the repository root:

```sh
uv run --project openbinding-gateway --locked python tools/bim_baseline.py
```

Options: `--output DIR` (default: the golden directory), `--jobs N` (default `min(4, cpus)`),
`--expected N` (default 82; the run fails and writes nothing if a package does not compile or the count
differs). It writes exactly `corpus.json`, `negatives.json`, `compat.json`, `vectors.json` and
`protocol.json`. Running it twice must give identical bytes:

```sh
uv run --project openbinding-gateway --locked python tools/bim_baseline.py --output /tmp/bim-a
uv run --project openbinding-gateway --locked python tools/bim_baseline.py --output /tmp/bim-b
diff -r /tmp/bim-a /tmp/bim-b
```

Regenerate the goldens only to record an intended, reviewed change of BIM semantics, never to make the
test pass.

## Tests

```sh
cd openbinding-gateway
uv run --locked pytest tests/test_bim_baseline.py                      # default: sample of 10 packages, < 60 s
BIM_BASELINE_FULL=1 uv run --locked pytest tests/test_bim_baseline.py  # additionally compares all 82
```

The default run regenerates 10 small packages (chosen from the golden corpus by candidate count, at most 4
per top-level directory), the compatibility of those packages, all negatives, all vectors and the protocol
section. The slow test is skipped unless `BIM_BASELINE_FULL=1`; the project does not register a `slow`
marker, so it is gated by that variable.

## Reuse in `bim-toolchain`

1. Copy `tools/bim_baseline.py` and the five goldens into the new repository, keeping the golden directory
   as is. In the copy, change `ROOT`, `DEMO`, `SCHEMA_DIR` and the two `check_bim_corpus` references to the
   new layout; corpus paths in the goldens are relative to the old repository root, so either keep the
   package paths identical or map them in `package_directories`.
2. Run the tool against the *old* repository first and confirm the goldens are reproduced byte for byte.
3. Run the unchanged test (`test_bim_baseline.py`, with `BIM_BASELINE_FULL=1` in CI) against the new
   toolchain. Any difference outside `toolchain` fields is a change of meaning: compare `semanticDigest`,
   then `sectionDigests`, then `evaluation.summary`, `blockDigests` and `bindingDigests` to localise it.
4. `compilerDigest`, `irDigest`, profile/dialect manifest digests and bundled versions are expected to
   differ; record the new ones under `toolchain` when the goldens are regenerated for the new repository.
5. `protocol.json` differences in `schemas` or `protocolDigest` mean the contract bytes changed: decide
   explicitly whether that is intended before regenerating.
