# BIM: directory versus ZIP equivalence

> **Status 2026-10-14: normalized (`bim-core` 0.2.0).** The owner decided to change the IR order; the compiler now lists
> the sets of the IR in one canonical order and a directory, its raw ZIP, its canonical ZIP and any permutation of its JSON
> members compile to the same IR and evaluate every binding the same way, in **82 of 82** packages (before: 64 of 82
> differed in the canonical ZIP). The decision, classification, evidence, versions and the impact outside `bim-toolchain`
> are in [`IR_NORMALIZATION.md`](IR_NORMALIZATION.md). Sections 1-5 below are the **history of 0.1.x**: what was measured
> when the divergence was open (head `cd0e05f0`/`f7f6fdb`, baseline `b2780381`) and why it was not fixed under the stop rule
> that the owner's decision replaced. Their figures are kept as measured then; §3 is superseded.

Question: is the package the goldens record (compiled from a **directory**) the package the platform runs (compiled from
a **ZIP**)? An earlier measurement looked at 10 of the 82 packages and found that the *order* of the eligibility lists
differs. This document gives the exact cause, the measurement on all 82, what was and was not changed, and why.

Result in one paragraph. The cause is **not** the enumeration order of the file system nor the order of the entries of
the ZIP. It is the order of the members of JSON objects: `InstancePackage.to_zip()` sorts them, and the compiler builds
three IR lists by iterating objects in document order. Compiled from a directory or from the ZIP of the package's bytes
(what the gateway stores), the 82 packages are identical. Compiled from the canonical ZIP of `to_zip()`, **64 of 82**
differ (not only in the eligibility lists: also in `constraints` and `placement`, and in `sourceMap`, which indexes
them). Fixing it with a canonical order moves the semantic digest recorded in the goldens for those 64 packages, so by
the stop rule of this work **nothing was changed in `bim-core` and no golden was regenerated**; the divergence is pinned
by strict `xfail` tests and a new golden, and documented.

## 1. Cause

Three forms reach the compiler:

| Form | How it is built | Where the JSON bytes come from |
| --- | --- | --- |
| directory | `load_package(directory)` | the files as written (`package.py:215-243`, `_read_directory`) |
| raw ZIP | `integrations/packages.py:26-52` `zip_directory` (the gateway), or any ZIP of the same bytes | the files as written, `load_package(bytes)` keeps them (`package.py:140-184`, `_validate_zip`) |
| canonical ZIP | `InstancePackage.to_zip()` | JSON rewritten in RFC 8785 form (`package.py:75-88` `_canonical_resource_bytes`; `package.py:345-361` `to_zip`, `canonical_files` at `:347-350`) |

1. **The medium is not the cause.** `_read_directory` enumerates with `root.rglob("*")` (`package.py:220`) and
   `_validate_zip` with `archive.infolist()` (`package.py:148`, `:154`); both fill a dictionary and finish in
   `_validate_files` (`package.py:187-212`). That dictionary is only read by key (`compiler.py:1566`), in sorted order
   (`compiler.py:1737`, `package.py:334`, `package.py:355`) or rebuilt sorted by `to_zip`. Measured: the raw ZIP of every
   package, with its entries in ascending and in descending order, and (synthetic packages) directories whose files
   were created in opposite orders, give the same semantic digest, IR, `irDigest`, `packageDigest` and eligibility
   order as the directory, for all 82 packages.
2. **The canonical form sorts object members.** `_canonical_resource_bytes` calls `canonical_json(strict_json_loads(...))`
   (`package.py:77-80`) and `canonical_json` sorts every object's members by UTF-16 code units (`canonical.py:93-98`).
   `to_zip()` applies it to every `.json` resource, including `instance.json`, the catalogs and the constraint sets.
3. **The compiler's lists follow document order.** Python dictionaries keep insertion order, `json` loads objects in
   document order, and these lists are built by iterating objects:
   - `spec.eligibility`: the catalogs come from iterating `instance.json` `spec.resources.<role>`
     (`compiler.py:1476`, `:1487`, appended to `by_type` at `:1735`), then `_normalize_candidates` walks the catalogs
     (`:2048`), each catalog's `candidates` (`:2078`) and appends to each task's list (`:2113-2149`; call at
     `:4271-4274`). The order of catalogs in `instance.json` and of candidates in each catalog is the order of the list.
   - `spec.constraints`: `_constraints` walks the constraint sets (`:2798`) and each set's `constraints` object
     (`:2800`); call at `:4364`.
   - `spec.placement`: `_placement` walks the placement resources (`:2921`), the groups (`:2971`) and, for a group
     selected by capability, the candidates of every catalog (`:2977-2981`), storing assignments in insertion order
     (`:2968`); call at `:4367`.
   - `spec.sourceMap` is not a list but its keys embed the position in the previous lists (`/spec/constraints/0`,
     `/spec/placement/0/...`), so it moves with them.
4. **Consequence.** A package that declares catalogs, candidates, constraint sets, constraints or placement groups out of
   alphabetical order has one IR as written and another once canonicalised. `packageDigest` is the digest of the
   canonical form (`package.py:336-339`), so it is the same for all forms and cannot tell them apart;
   `compilation_digest` is `digest({packageDigest, profile, dialects, compilerDigest})` (`compiler.py:3510-3528`), which
   does not contain the IR either. The gateway deduplicates snapshots by `(owner, package_digest, compilation_digest)`
   (`services/snapshots.py:326-333`, `db/models.py:334`): two uploads of the same package in different forms get the same
   key and keep the IR of whichever was stored first. The platform's own `zip_files` does not canonicalise
   (`integrations/packages.py:26-36`), so what the platform builds from a directory is the "raw" form; a client that
   uploads `to_zip()` output gives the other.

## 2. Measurement (82 packages)

Run: `BIM_BASELINE_FULL=1 uv run --locked pytest tests/test_bim_baseline.py tests/test_bim_zip_dir_equivalence.py
tests/test_package_bomb.py` in `openbinding-gateway` (295 passed, 64 strict xfailed), and the toolchain suite (see
section 5). `BIM_ZIP_DIR_REPORT=<file>` writes the per-package measurements as JSON.

For each package, five things were compared between the directory and each other form: (a) semantic digest,
(b) canonical IR (`canonical_json` of the document), (c) `irDigest`, (d) `packageDigest`, (e) order of the eligibility
lists.

| Form compared with the directory | Packages equal in (a)-(e) | Packages different |
| --- | ---: | ---: |
| raw ZIP built by the gateway (`zip_directory`) | 82 | 0 |
| the same raw ZIP, entries in reverse order | 82 | 0 |
| canonical ZIP (`to_zip()`) | 18 | **64** |

`packageDigest` is identical in every form for all 82. In the 64, (a), (b), (c) differ; (e) differs where `spec.eligibility`
is among the sections. With the order of the lists forgotten (every list replaced by the sorted canonical forms of its
items) `spec.eligibility`, `spec.constraints` and `spec.placement` are equal for all 82: the members are the same, only
their order differs. Sections that differ, by group:

| Packages (count) | Differing sections of the IR | Evaluation of the canonical ZIP against the golden |
| --- | --- | --- |
| `examples/demo/05_multi_obj`, `05_single_obj_various`, `13_fms`, `14_shared_candidates`, `17_analysis_tradeoffs` (5) | `eligibility` | exhaustive: summary equal, digests in enumeration order differ |
| `examples/demo/15_bpmn_complete`, `16_json_complete`, `examples/placement/01_small_placement`, `03_cloud_only`, `04_edge_heavy`, `engines/minizinc-csp/tests/fixtures/placement` (6) | `eligibility`, `constraints`, `placement`, `sourceMap` | exhaustive: summary equal, digests differ |
| `examples/placement/02_stock_market_sample` (1) | same four | sampled: **summary differs** (other bindings drawn) |
| `examples/demo/18_analysis_constraints`, `19_analysis_journey` (2) | `eligibility`, `constraints`, `sourceMap` | exhaustive: summary equal, digests differ |
| `examples/literature/zhang` (1) | `constraints`, `sourceMap` | exhaustive: **evaluation digests equal** (the only one) |
| `examples/literature/pautasso` (1) | `constraints`, `sourceMap` | sampled: summary equal, digests differ |
| `experimentation/icws/instances/{benatallah2002-selfserv-travel-solution-cts-itas, cremaschi2018-textbook-access, netedu2020-transport-agency, zhang2014-entertainment-planner-running-example}_{many,mono_one,mono_utility,multi}_{hard,soft}` (32) | `eligibility`, `constraints`, `sourceMap` | sampled: **summary differs** (other bindings drawn) |
| `experimentation/icws/instances/{bultan2003-warehouse-example, pautasso2009-restful-ecommerce}_{...}` (16) | `constraints`, `sourceMap` | sampled: summary equal, digests differ |

Totals: 64 packages with another semantic digest and `irDigest`; 33 of them (`02_stock_market_sample` and the 32 ICWS
instances of four families) also change the summary of the baseline's sampled evaluation, because the 16 seeded draws
pick other candidates from lists in another order; 30 more only change the digests in enumeration order, and
`examples/literature/zhang` changes none (33 + 30 + 1 = 64). All exhaustive evaluations keep every summary: the same
bindings are evaluated, in another order, and their results do not depend on the order.

The 18 packages equal in every form are `engines/minizinc-csp/tests/fixtures/{loops,simple-sequence,xor-choice}`,
`examples/demo/{01_simple_seq,02_parallel,03_xor_choice,04_conflict,06_loops,07_soft_constraints,08_dependencies,09_mixed,10_large_scale,11_multi_obj_negative,12_many_obj_pareto}`
and `examples/literature/{benatallah,bultan,cremaschi,netedu}`. The earlier measurement on ten demo packages was right
about them (2 differ: `05_multi_obj`, `05_single_obj_various`) but the sample hid that the difference extends to
`constraints`, `placement` and `sourceMap` and to 64 packages.

Per-package detail (`packageDigest`, whether the raw and the canonical ZIP equal the directory, the semantic digest of
the canonical ZIP, the differing sections) was pinned in `bim-toolchain/golden/bim_core/zip_equivalence.json` (deleted
with 0.2.0: all forms are equal now, see `golden/bim_normalized/zip_equivalence.json`). `irDigest` values are not stored
there: they move with `compilerDigest`.

## 3. Decision: not fixed (stop rule) — superseded on 2026-10-14

*Historical.* The stop rule below was replaced by the owner's decision of 2026-10-14; the change it describes as MAJOR was
made (`bim-core` 0.2.0) and `golden/bim_baseline` is kept frozen as the baseline of 0.1.x. See `IR_NORMALIZATION.md`.

The proposed fix is a canonical, medium-independent order applied alike to directory and ZIP (sort `eligibility`,
`constraints` and the placement assignments by a key such as `(resource, id)` and re-index `sourceMap`). It would make
all forms equal. It was **evaluated, not applied**, because the IR of the canonical ZIP is exactly the IR such a
normalisation gives the directory (both are the sorted-member order), and:

- its semantic digest differs from the one `golden/bim_baseline/corpus.json` records for 64 packages
  (`test_a_canonical_order_would_move_the_golden_of_exactly_the_divergent_packages`); the digest defined in
  `bim-toolchain/docs/DIGESTS.md` covers `eligibility`, `constraints` and `placement`;
- the enumeration order of every exhaustive evaluation changes, so `rollupDigest` and `bindingDigests`/`blockDigests`
  of 63 of the 64 packages change, and for 33 sampled packages the summaries change too.

The stop rule says: if the fix changes the semantic digest or the evaluation result of any package, do not regenerate;
revert and leave the equivalence test as a strict `xfail` with the cause. No source file of `bim-core` was edited, so
there was nothing to revert; no golden of `golden/bim_baseline`, `tests/golden/bim_baseline` or the existing
`golden/bim_core` was touched. Decision for the owner: canonicalise (MAJOR change, below) or keep compiling a single
form of a package.

**Version.** `bim-core` stays `0.1.0` (unreleased): no `bim_core` byte changed, so neither `compilerDigest` nor any
`irDigest` changed, and there is no digest change to list. If the owner canonicalises, it is a MAJOR change by
`docs/DIGESTS.md` ("a valid package changes semantic digest or evaluation"): all 64 packages above change digest, the
goldens are regenerated with `tools/baseline_core.py` in a reviewed change, and since `0.1.0` has never been released it
is folded into the first release or shipped as the next breaking number, at the owner's choice.

## 4. What was added

- `openbinding-gateway/tests/test_bim_zip_dir_equivalence.py`: the comparison above for the 82 packages. It **fails**
  when the corpus is missing; it is skipped only with `BIM_ZIP_DIR_ALLOW_NO_CORPUS=1`. The 64 canonical-ZIP cases are
  `xfail(strict=True)` with the cause, so a fix (or a regression of the 18) makes the suite fail until the list, this
  document and the version are updated. It also pins which packages' evaluations move.
- `openbinding-gateway/tests/test_bim_baseline.py`: the sample (and, with `BIM_BASELINE_FULL=1`, all 82) compiled from
  the ZIP the platform builds must have the golden's semantic digest.
- `bim-toolchain/tools/baseline_core.py` + `golden/bim_core/zip_equivalence.json` (new golden, created by the repo's own
  mechanism `check_or_create_golden`): `--check` fails if a raw ZIP is not its directory; the canonical divergence is
  pinned.
- `bim-toolchain/packages/bim-core/tests/test_zip_dir_equivalence.py` and `synthetic_packages.py`: the same comparison
  on small synthetic packages generated by the tests (no corpus, no dataset), run by the repository's own CI; five
  variants (ordered; unordered catalogs, candidates, constraint sets, constraints).
- `bim-toolchain/packages/bim-core/tests/test_limits_near_boundary.py`: `Limits` exactly at and one unit beyond the
  boundary for ZIP, directory and in-memory packages; a 4 MiB entry at the limit loads with bounded memory and time and
  one byte more is refused before it is read. No load test.
- `bim-toolchain/.github/workflows/ci.yml`: the corpus job fails without a corpus (explicit opt-out
  `BIM_CORPUS_OPTIONAL=true`, announced in the job summary) and runs `baseline_core.py --check` with
  `BIM_REQUIRE_CORPUS=1`; new jobs `equivalence` (no skips), `all-packages` (the three suites in one session, as the
  release workflow does) and `gate` (every job must be `success`); Python 3.11 and 3.12 for the corpus, contract,
  equivalence and all-packages jobs; the contract job also checks the goldens' byte form and protocol digests with no
  corpus. The workflow was edited, not run.

## 5. Results of the runs

Executed through the registered checks, on 2026-10-13 (CPython 3.11.2, locked environment of `openbinding-gateway`):

| Check | Result |
| --- | --- |
| gateway: `tests/test_bim_baseline.py`, `tests/test_bim_zip_dir_equivalence.py`, `tests/test_package_bomb.py` with `BIM_BASELINE_FULL=1` | 295 passed, 64 xfailed (strict), 0 failed |
| toolchain: `packages/bim-core/tests` and `tools` | 1156 passed, 5 xfailed (the 4 unordered synthetic variants of this change; the fifth was not inspected), 23 skipped (22 are `test_built_artifacts.py`, which needs built wheels; the other was not inspected; none belongs to the new tests), 0 failed |
| `tools/consumer_fixtures.py --check`, no `uv.lock`/`.venv` in the diff, `git diff --check` | clean |

The first toolchain run after adding `golden/bim_core/zip_equivalence.json` failed twice, as designed
(`check_or_create_golden` writes a missing golden and fails once; `mismatches` cannot read it before it exists); the
second run passed. The measurements of section 2 were taken with the same test before it was frozen: a first version
with an empty list of known divergences failed and printed the 64.

Order-dependent failure of `test_the_goldens_cover_exactly_the_discovered_corpus`: the QA `TMPDIR` is a hidden `.qa-tmp-*` directory inside the worktree, `test_package_directories_skips_excluded_roots` leaves its `tmp_path` fixtures (`instance.json`) there until the session ends, and `package_directories` walked them as packages; `baseline_core.package_directories` (and the 82-package filter of `test_b5_corpus.py`) now skip hidden directories, which hold no package of the real corpus (still exactly 82); the goldens were not regenerated.

Not verified: the workflows on GitHub (edited only), Python 3.12, `bim-service` and `bim-client` suites (outside this
change), the Docker image.

## A1: equivalencia en tests de bim-core

Phase A1 pins the directory / raw ZIP / canonical ZIP equivalence with tests that belong to `bim-core`, without
touching its behaviour:

- `bim-toolchain/packages/bim-core/tests/test_zip_dir_equivalence_corpus.py`: for the 82 packages of
  `golden/bim_baseline/corpus.json` (the same set `tools/baseline_core.py` `package_directories` discovers, hidden
  directories skipped; a test compares both), the directory against (a) the raw ZIP: 82/82 equal in `irDigest`,
  `packageDigest`, canonical IR, semantic digest and list order; (b) the canonical ZIP (`to_zip()`): the 64 known cases
  are `xfail(strict=True, raises=AssertionError)` with the cause (order of the members of JSON objects), the other 18
  must be equal. Its `normalized()` helper is a copy of `observe()` of the gateway test (which has no `normalized`).
- `bim-toolchain/packages/bim-core/tests/data/zip_divergent_packages.json`: the 64 divergent packages. A gate test
  requires the measured set to be exactly that file; if the compiler changes and the set changes, the test fails and
  the file is not updated by itself (`BIM_WRITE_DIVERGENT=1` rewrites it for a reviewed change).
- Without the corpus the tests skip with the reason; with `BIM_REQUIRE_CORPUS=1` they fail.

**No digest was moved**: nothing in `bim_core/src`, no golden and no digest changed in A1.

**Still the owner's decision**: phase A2 (a public function and an `irOrderDigest`) and the MAJOR phase B (an `irOrder`
option). Neither is started.

**Warning before A2/B**: adding `irOrderDigest` in `bim_core/src` moves `compilerDigest` and every `irDigest`. The
gateway rejects with `contract_not_installed` a stored IR whose exact profile is not installed (`compiler.py` ~3583), so
any publication of `bim-core` requires first checking how stored IRs are re-evaluated.

## Estado de la decisión

**Normalizado (2026-10-14, `bim-core` 0.2.0).**

1. El ZIP crudo del gateway (`zip_directory`) es equivalente al directorio en los 82 paquetes (ya lo era).
2. El ZIP canónico `to_zip()` **ya es equivalente** al directorio en los 82: IR, `irDigest`, digest semántico, orden de las
   listas y evaluación de los mismos bindings, byte a byte. Lo mismo para el ZIP crudo con las entradas invertidas y para dos
   permutaciones de los miembros de los objetos JSON. Antes (0.1.x) diferían 64 de 82 por el orden de los miembros de los
   objetos JSON, no por el medio.
3. Canonicalizar el orden de las listas del IR fue un cambio MAJOR del digest semántico (64 paquetes cambian de digest
   semántico, 18 no) y **se aplicó** por decisión del propietario: ver `IR_NORMALIZATION.md` y `bim-toolchain/CHANGELOG.md`
   (`semantic-change`). El host ya no necesita compilar siempre la misma forma del paquete.
4. Los `xfail` estrictos (64 de corpus, 4 sintéticos `unordered-*`) pasan a ser tests ordinarios; el `xfail` de `has()` sobre
   un intervalo era otro defecto y se corrigió con su propia evidencia. La baseline de 0.1.x queda congelada en
   `golden/bim_baseline` (commit `b2780381`) y los tests comparan por identificador con ella.
5. Los tests del gateway que esperaban la divergencia o el golden antiguo (70) se actualizaron en la tarea K2 (ver
   `IR_NORMALIZATION.md` §7): el golden del gateway es el de `golden/bim_normalized` y las evaluaciones se comparan por
   identificador con la baseline previa. Queda un pin de `tools/bim_conciseness_benchmarks.json` (§7 de ese documento).
