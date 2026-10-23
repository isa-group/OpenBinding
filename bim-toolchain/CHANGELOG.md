# Changelog

All notable changes to the three distributions (`bim-core`, `bim-service`, `bim-client`) are recorded here. The
three are versioned together. The version follows SemVer with the digest rules of
[`docs/DIGESTS.md`](docs/DIGESTS.md); a release changes `compilerDigest` by definition, and says so below when it
changes anything else.

## [Unreleased]

No file under `packages/*/src` changed, so `compilerDigest` is still
`sha256-ccc55839be2e311d7adfe3c44ee0a70a6e7b19acb28b786f8dee6a8da593418e`, and no semantic digest, evaluation, diagnostic,
compatibility result or protocol digest moved (`baseline_core.py --check`: 82 packages, 0 differences). Packaging,
licensing, goldens' metadata, export and verification only.

### Added

- **License: CC-BY-4.0**, the license of OpenBinding, holder javiercavlop (titular del repositorio OpenBinding; no legal name
  is recorded and none was inferred). `license = "CC-BY-4.0"` (SPDX, PEP 639) in the three `pyproject.toml` (the wheels and
  sdists carry `License-Expression: CC-BY-4.0`), `license-files = ["LICENSE", "NOTICE.md"]` (each package carries a byte copy of the root `LICENSE`; the first draft listed only `NOTICE.md`), `Private :: Do Not Upload` kept;
  `NOTICE.md` (and its three copies) rewritten, `THIRD_PARTY_NOTICES.md` keeps OpenBinding's text and adds a section, new
  `licenses.json` (the manifest: SPDX identifier once, scope, clearance switch, pending pins) and `docs/LICENSING.md`
  (attribution, scope, and the recorded risk that CC BY 4.0 is not designed for software; the decision of the holder is
  untouched). The SPDX identifier is deliberately not a header in every `.py`: it would change `compilerDigest`.
- **OMG BPMN XSD inventory** (`tools/xsd_inventory.py`, `docs/OMG_XSD_RIGHTS.md`): per file, the bytes' SHA-256 and size, the
  origin and digest the vendored README declares, and whether the bytes contain a copyright or license notice. None of the five
  does (and none has an XML comment): the README and the previous `NOTICE.md`, which said the notices were preserved, were
  wrong about these bytes. State: not demonstrated; `licenses.json` → `omg_bpmn_xsd.cleared` records it (the files no longer
  depend on it: see the next entry). `--fetch` downloads the five files from the official source and verifies their SHA-256
  (nothing is written unless all match); it was tested with a stand-in for the network.
- **The five OMG BPMN XSDs are no longer versioned in Git, and every build downloads them verified.** `.gitignore` (the root of
  OpenBinding and the one of `bim-toolchain`) ignores them; `licenses.json` says `present_in_tree: false`;
  `tools/xsd_inventory.py --check` (also in the tests and in the lint job) fails if `git ls-files` lists one or Git does not
  ignore it. New `packages/bim-core/hatch_build.py` (standard library only, outside `src/bim_core`: `compilerDigest` and the
  goldens do not change): it downloads the files over https, compares each SHA-256 with the declared one and writes nothing
  unless all five match; it is a hatchling build hook (`[tool.hatch.build.hooks.custom]`), so `pip install` from the sources,
  `pip install -e`, `uv sync` and `uv build` put the files in place first; `[tool.hatch.build] artifacts` and `/hatch_build.py` in the
  sdist `include` make the wheel and the sdist carry them. `tools/xsd_inventory.py --ensure` (nothing to do if they are
  there; without network, an error with the exact command) runs after every checkout of the workflows (and in the root CI job
  `bim-corpus`); the Dockerfiles of `bim-service`, `openbinding-gateway` and `experimentation/qacobench` copy the hook and run
  it before the install; `tools/xsd_session.py` (in the `conftest.py` files) ensures the files before a test session and
  `packaging_support.ensure_xsd()` before anything is built. The wheels, sdists, SDK and images **do** carry the files
  (`verify_release.py` and `test_built_artifacts.py` compare their bytes with `licenses.json`); whether they may is a
  decision of the owner (rights not demonstrated, `docs/OMG_XSD_RIGHTS.md`). The tests never use the network (injected opener).
- **`tools/export_repo.py`**: exports the committed `bim-toolchain/` of an OpenBinding clone as a new repository (one commit by the
  invoking identity, neutral message citing the source commit, no history, remote, tag or push). Refuses on secrets, an
  inconsistent license inventory, files that are not the holder's own, links that leave the repository, or a failing
  self-containment run (`-m 'not openbinding_corpus'`, no skip; the OMG XSDs are downloaded into the copy where it runs). It
  also refuses a committed tree that versions the OMG XSDs; the `--xsd` switch is gone. `docs/DELIVERY.md` has the steps for the
  Mac, the expected values and the rollback.
- **`tools/verify_release.py`**: two builds in two directories with a fixed `SOURCE_DATE_EPOCH` compared by SHA-256 (identical
  in the recorded run: `bim_core-0.2.0-py3-none-any.whl` `80dd58ba…`, `bim_core-0.2.0.tar.gz` `690da1fb…`,
  `bim_service-0.2.0-py3-none-any.whl` `45ca51bd…`, `bim_service-0.2.0.tar.gz` `e767c77f…`, `bim_client-0.2.0-py3-none-any.whl`
  `5cff0e6c…`, `bim_client-0.2.0.tar.gz` `725621fc…`; full values in `docs/DELIVERY.md`), clean venv, `python -I` smoke test,
  `compilerDigest` of wheel/tree/sdist/installation/service, OpenAPI and consumer fixtures, corpus baseline,
  `toolchain.json` from the installed wheels; one JSON summary, exit 1 on any failure.
- **The corpus tier**: the tests that read the OpenBinding corpus carry the marker `openbinding_corpus`, found by reading the
  tests (`tools/corpus_tier.py`), not by hand. `-m 'not openbinding_corpus'` runs everything else; a guard test runs exactly
  that against an empty corpus and fails on a skip or a failure. `golden/synthetic/corpus.json` (synthetic variants and the
  example package: digests, evaluations, Engine compatibility, directory/ZIP forms) is the golden that needs no corpus. The
  82-package corpus is not copied (the licenses of the datasets it comes from could not be verified).
- **`tools/regen_normalized_metadata.py`** and `docs/GOLDEN_METADATA.md`: refresh the informative `toolchain` members of
  `golden/bim_normalized/corpus.json` and of the gateway's byte copy, after verifying that everything else is identical;
  comparison in `golden/toolchain_metadata_comparison.json`. `test_golden_toolchain_metadata.py` fails if the installed
  `compilerDigest` differs from the registered one.
- Workflows: every `uses:` is marked `PIN-PENDING`; `tools/test_workflows.py` fails on one that is neither marked nor pinned to
  a 40-hex SHA and compares the list with `licenses.json`; the jobs that run the suites leave out the corpus tier and fail on a
  skip; a `verify_release.py --skip-corpus` step in `ci.yml` and `release.yml`.

### Changed

- **The six artifacts changed** (`bim-core` has a build hook and an `artifacts` entry, `hatch_build.py` is in its sdist, and
  `NOTICE.md` has a new text in the four places): the hashes of `docs/DELIVERY.md` are out of date; run
  `python3 tools/verify_release.py --skip-corpus` for the current ones. `compilerDigest`, `protocolDigest`, `irDigest` and the
  goldens are the same.
- `golden/bim_normalized/corpus.json` and `openbinding-gateway/tests/golden/bim_baseline/corpus.json` (same bytes): only
  their `toolchain` members, `compilerDigest` `sha256-749170b5…` → `sha256-ccc55839…` (the 0.2.0 value) and the 82 `irDigest`;
  SHA-256 `9322bc09…` → `6f60c4fa…`, 165 lines, same size. `golden/bim_baseline` and `golden/ir_previous` untouched.
- The packaging tests no longer skip for lack of `dist/` or `.verify-venv`: they build them on demand (`uv`; a missing `uv` is
  an error) and rebuild when the sources change.
- `test_boundary.py`, `test_packaging_metadata.py` and `test_built_artifacts.py` assert the license (they used to assert that none
  was declared); the byte-identity test of `THIRD_PARTY_NOTICES.md` became "OpenBinding's file is a byte prefix".
- Three Markdown links that pointed outside the repository (to `docs/qa/…` and `docs/IDEMPOTENCY.md` of OpenBinding) are now
  plain references.

### Not done

- `packages/*/README.md` (shipped as the long description of the wheels) still say the license is undecided; they were outside
  the files this change could touch.
- The SHAs of the actions, the first run of the workflows, the Docker image, Python 3.12, `ruff`, the export on macOS and the
  publication: none was verified or done (`docs/PACKAGING.md`, `docs/DELIVERY.md`).

## [0.2.0] - 2026-10-14

Not released: nothing has been published, tagged or pushed. The three distributions go from `0.1.0` (never
published) to `0.2.0` together.

### semantic-change: the sets of the IR are listed in one canonical order

**Class: MAJOR** by [`docs/DIGESTS.md`](docs/DIGESTS.md#versioning-rules) and [`docs/RELEASING.md`](docs/RELEASING.md)
("a valid package changes semantic digest or evaluation"). Before 1.0 the breaking number is the minor, so the version is
`0.2.0` and `bim-service` and `bim-client` now require `bim-core>=0.2,<0.3`. Decision of the owner of 2026-10-14. There
is no compatibility mode, no second implementation of the old order and no migration code: a stored IR of `0.1.x` is
valid and evaluable as it is (same members, same evaluations) but is not an IR of this toolchain
(`contract_not_installed`, as after any change of `compilerDigest`) and must be recompiled to get the new order.
Analysis, classification and evidence: `docs/qa/IR_NORMALIZATION.md` of the OpenBinding repository (not part of this one).

- **What changed.** `bim_core.compile_instance` lists, in one order that depends only on identifiers and not on how
  the package was serialized: `spec.eligibility[task]` by `(catalog id, candidate id)`, `spec.constraints` by `ref`,
  `spec.placement` by resource id and, inside a model, `demands` by candidate and `transitions` by `ref`;
  `spec.sourceMap` is written after sorting, so `/spec/constraints/<i>` and `/spec/placement/<i>/...` carry the final
  index. Arrays the author writes (`network`, `capacityRules`, `optimization.criteria` and `penalties`, the
  workflow, `routing.entries`) keep their order, because the order is data. A parsed JSON document also reads an
  integral number (`6.0`, `1e3`, `-0.0`) as an integer, as the canonical form writes it (`bim_core.canonical.integral_numbers`),
  so the message of a transition violation reads `maximum 6`, not `maximum 6.0`, whatever the form of the package.
- **Result.** A directory, the ZIP of its bytes (either order of entries), its canonical ZIP (`InstancePackage.to_zip()`)
  and the package with the members of its JSON objects shuffled compile to the same IR, byte for byte (canonical JSON),
  and evaluate every binding to the same evaluation, order and text of the violations included: 82 of 82 corpus
  packages in all five forms. Before, 64 of 82 differed in the canonical ZIP.
- **Digests that move.** `compilerDigest` `sha256-e2f269aadbb75cb8c09fb3090a4e12b6b0999a11bbbd8de7c991185dd8605b23` →
  `sha256-ccc55839be2e311d7adfe3c44ee0a70a6e7b19acb28b786f8dee6a8da593418e`; the builtin Profile `qos-binding`
  `1.0.0+csdgtbuugavgxg3a7h3w2x6h2ixunyufqwvisq2makw6kv7dehwq` and Dialects (`qos-binding`
  `1.0.0+jdok6lhcwa6wt5c2st5jdppigjh4gwnczpyg77inamuet7qyt7zq`, `bpmn-workflow`
  `1.0.0+jmfo6wmfcspi3d7khvjn7sikgmcgwnvxwesfq4xlljcrwotfipya`, `qos-binding-placement`
  `1.0.0+yizryf6yoacyp77d3dggiuzsknmlik2gkdbmyavjx3haiq2auhja`); therefore **every** `irDigest` and `compilationDigest`.
  The **semantic digest moves for 64 of the 82 corpus packages** (`packages/bim-core/tests/data/zip_divergent_packages.json`),
  in `eligibility`, `constraints` and `placement` only; the other 18 keep every digest, evaluation digests included.
  `packageDigest`, `inputDigest`, `instanceDigest`, the digests of the schemas, the engine contract and the protocol do
  not move.
- **Evaluations.** The evaluation of a binding is the same set of values and violations as before for all 82
  packages (checked on 1 582 bindings chosen by identifier, `golden/ir_previous/evidence.json`); the order of
  `violations` is now the canonical one (constraints by `ref`, then placement by model, demand and transition), and
  the exhaustive summaries of `golden/bim_baseline` are unchanged. What changes is the **enumeration order** of an
  exhaustive evaluation (so `rollupDigest`, `bindingDigests` and `blockDigests` of 13 of the 14 exhaustive packages that
  moved; `examples/literature/zhang` keeps every digest) and the **binding a seed picks**: engines index
  `eligibility[task]` with their generators (`eligible.get(random.nextInt(n))`, MiniZinc by position), so the same seed
  yields another binding, now the same one for every form of a package. The baseline's 50 sampled packages that moved
  draw other bindings and 33 of them have another summary. No protocol field is a position: bindings, solutions,
  violations and penalties name `{resource, id}`.
- **Contracts and goldens.** `contracts/openapi/bim-service.v1.json`: only `info.version` (no path, schema or status
  changes). `contracts/consumers/openbinding/*.json`: the informative `toolchain` members (`compilerDigest`, `irDigest`);
  no expected body changed (the demo package was already in canonical order). `golden/bim_baseline` is frozen (the
  previous toolchain's baseline, commit `b2780381`, its SHA-256 pinned in `golden/ir_previous/evidence.json`) and is the
  fixture the normalized toolchain is compared with, by identifier; the baseline of the new toolchain is
  `golden/bim_normalized/{corpus,zip_equivalence}.json`, created after the invariants held. `golden/bim_core/zip_equivalence.json`
  is superseded by the latter.
- **Tests.** The 64 strict `xfail` of `test_zip_dir_equivalence_corpus.py` and the four `unordered-*` of
  `test_zip_dir_equivalence.py` are ordinary tests (they pass), with permutations of the JSON members and exact
  equality of the evaluations added; the strict `xfail` of `test_analysis_ir_probe.py` is a test of the closed defect.
- **Not covered.** The engines (`engines/**`) were not run: their seeded outputs, if a test pins them, change once.
  The `openbinding-gateway` pins (now `bim-core>=0.2,<0.3`, `bim-client>=0.2,<0.3`), its corpus golden (a copy of
  `golden/bim_normalized/corpus.json`) and the tests that compare with them were updated afterwards (see
  `docs/qa/IR_NORMALIZATION.md`, "Impact outside bim-toolchain").

### Security

- `bim-core`: integer results of expressions are bounded. `pow`, `mul`, `product`, `weightedSum` and
  `weightedProduct` refuse, before computing it, an integer result above the new `Limits.max_integer_bits`
  (`BIM_MAX_INTEGER_BITS`, default 1 000 000 bits) with `ExpressionError(code="integer_limit")`. Before, a literal
  such as `10 ** (10 ** 10)` in a package kept a thread at 100% and grew memory without bound, both when the
  package was compiled (constant soft penalties are evaluated at compile time) and when a binding was evaluated;
  `POST /bim/v1/compile` and the gateway's `POST /v1/instances/validate` were reachable with it. A constant soft
  penalty above the limit is now a `soft_penalty` diagnostic of the compilation, and a constraint that exceeds it
  while evaluating a binding is an `EvaluationError` (`evaluation_failed`). Float overflow and `0 ** -n` inside
  `product`, `weightedSum` and `weightedProduct` are `ExpressionError`s too instead of a bare `OverflowError` /
  `ZeroDivisionError`. Results that fit are computed exactly as before; the limit is read from the process default
  (`bim_core.configure`).
- `bim-core`: the ZIP reader no longer trusts the declared size or the compression method of an entry. Only STORED
  and DEFLATED entries are read (any other method is a `PackageError`, `unsupported compression method`), an entry
  is read in 64 KiB chunks and refused as soon as it yields more than its declared size, and a corrupt DEFLATE
  stream is a `PackageError` (`could not read package entry`) instead of a `zlib.error`. Valid packages, whose
  sizes are honest, load unchanged.
- `openbinding-gateway`: `integrations.packages.instance_document`, which reads `instance.json` before the toolchain
  has judged an archive, applies the same rules (STORED/DEFLATED only, entry limit, compression ratio, chunked read
  bounded by the declared size) with the standard library; the compilation that follows reports the real error.

### Toolchain digests

`compilerDigest` and the builtin Profile and Dialect versions change with these edits (`settings.py`,
`expressions.py`, `compiler.py` and `package.py` changed); no semantic digest, evaluation, diagnostic of the
baseline or protocol digest moved. See `docs/DIGESTS.md`.

The digests of this release are those of the `semantic-change` record above: `compilerDigest`, the builtin Profile and
Dialect versions and every `irDigest` change with the edits of `compiler.py`, `canonical.py`, `expressions.py` and
`_version.py`, and the semantic digest of 64 corpus packages moves with the new order (`docs/DIGESTS.md`).

### Fixed

- `bim-core`: `has(path)` asks for presence only. It fetched the value of the last segment right after the membership
  check, so `has(tasks.t1.features.x)` raised `ValueError` when the slot of `x` holds an interval (which the canonical
  evaluator refuses to read); it is now `True` without reading it (`expressions._path_exists`). The strict `xfail` that
  pinned the defect (`test_has_on_an_interval_slot_is_true_without_reading_the_value`) is an ordinary test.
- `bim-core`, `bim-service`, `bim-client`: `analysis.bindingSpaceCardinality` is built in blocks of 500 digits
  (`BindingProblem.binding_space_cardinality_decimal`, `bim_core.canonical.decimal_string`). `str()` of a cardinality of
  more than 4300 digits raised `ValueError` ("Exceeds the limit (4300 digits) for integer string conversion"); it
  reproduced in `InProcessBim.compile` and in `/compile` and `/validate` of the service (a 500) with 15 000 service tasks
  of two candidates, before anything reached the gateway. The value and the wire format (a decimal string) do not change.
- `POST /bim/v1/engines/validate` and `InProcessBim.validate_engine` answer an engine document whose `spec` is not
  an object with the diagnostic `{code: "engine_contract_invalid", message, pointer: "/spec"}` instead of a 500 /
  `AttributeError` raised by `bim_core.engine_contract_diagnostics` (which is unchanged). The OpenAPI schema does not change.

### Added

- `bim-service` (B8-2, both off by default, so behaviour is unchanged unless set): `BIM_SERVICE_SWITCH_INTERVAL`
  (seconds; `sys.setswitchinterval` applied by the lifespan and restored at shutdown) and
  `BIM_SERVICE_MEMORY_BUDGET_BYTES` (each operation is charged 8 times its body from the slot until its thread ends; a
  request that does not fit is `429 memory_budget` with `Retry-After`, a request larger than the whole budget runs only
  when nothing else is in flight). `limits.service` of `GET /bim/v1/capabilities` publishes `switchIntervalSeconds` and
  `memoryBudgetBytes` (additive). See `docs/SERVICE.md`, "Where the work runs" and "Memory budget".
- Tests without the corpus: `packages/bim-core/tests/test_zip_dir_equivalence.py` (synthetic packages written by
  `synthetic_packages.py`: directory, raw ZIP in any entry order, canonical ZIP and shuffled JSON members compared on
  semantic digest, IR, `irDigest`, `packageDigest` and eligibility order, and on the evaluation of every binding) and
  `test_limits_near_boundary.py` (`Limits` at their boundary for ZIP, directory and in-memory packages, with bounded
  memory and time near the limit).
- `tools/baseline_core.py` compiles every package from its directory and from each other form (raw ZIP in either order
  of entries, canonical ZIP, two shuffles of the JSON members) and writes `golden/bim_normalized/zip_equivalence.json`;
  `--check` fails if any of them is not the package compiled from its directory. It also holds the harness that
  compares a toolchain with the previous one by identifier (`identifier_bindings`, `package_evidence`,
  `build_previous_evidence`), and `tools/failure_digest.py` repeats the failures of a pytest run at the end of its output.
- `BIM_REQUIRE_CORPUS=1` makes the corpus tests fail instead of skip.
- CI: the corpus job fails without a corpus unless the repository variable `BIM_CORPUS_OPTIONAL` is `true` (and then it
  says in its summary that it skipped); new jobs `equivalence` (synthetic directory/ZIP equivalence, no skips),
  `all-packages` (the three suites in one session, as the release workflow runs them) and `gate` (fails unless every
  job succeeded, so a skipped job is not a pass); the corpus, contract, equivalence and all-packages jobs run on
  Python 3.11 and 3.12; the contract job also checks the goldens' byte form and protocol digests without the corpus.
- `bim-service`: four endpoints for single documents, additive within `bim-service/v1` (a MINOR change of the HTTP API;
  `bim-core` is untouched): `POST /bim/v1/resources/validate`, `POST /bim/v1/engines/validate`,
  `POST /bim/v1/resources/xml/root` and `POST /bim/v1/resources/xml/validate-bpmn`. Same bearer authentication, body
  limit and `application/problem+json` errors as the other `POST` routes; the XML is bounded by the package entry
  limit and refused when it declares a DTD, an entity, an XInclude or a `schemaLocation`.
  `contracts/openapi/bim-service.v1.json` is regenerated.
- `bim-client`: `BimResourcePort` (`validate_resource`, `validate_engine`, `xml_resource_root`, `validate_bpmn_resource`),
  implemented by `InProcessBim` with `bim-core` and by `HttpBim` over the new endpoints. `InProcessBim` applies its
  package `Limits` to a standalone XML resource.

### Changed

- `bim-service` (B8-1): decoding and validating a request body (`json.loads`, validation of the models including the
  NaN/infinity walk, base64, multipart) and rendering the answer move from the event loop to the existing bounded worker
  pool (same `BIM_SERVICE_MAX_CONCURRENCY` slots and semaphore; no new pool, no limit raised). The slot is taken
  **before** the body is decoded, so a request that finds no slot decodes nothing and the decoded bodies in memory are
  bounded by the slots. The 422 `request_invalid` (pointers below `/body`), 400 `http_error`, 415 and 413 answers are
  unchanged; the one visible difference is that while every slot is taken a malformed body is answered 503
  `service_busy` (or 429) instead of 422. The slot is still released when the *thread* ends, not at the timeout. In
  thread mode this bounds the cost, it does not remove it: `json.loads` and pydantic-core hold the GIL, so a large body
  can still stall the loop (the strict `xfail` for that, for CPU-bound threads and for the slot kept after a timeout
  stay). `contracts/openapi/bim-service.v1.json` is regenerated: the request bodies are declared by hand with the same
  schemas, and the `429` description names `memory_budget`.
- `bim-client`: `HttpBim` no longer raises `BimOperationUnavailable` for those four operations; it sends them.
  `BimOperationUnavailable` stays exported (compatibility) but nothing raises it.
- **Contract change, `bim-service`: the per-tenant concurrency share is keyed by the authenticated identity, not by
  `X-BIM-Tenant`** (analysis B5). Before, the share was keyed by a header that any holder of a token chose per request,
  so changing it took a fresh share, omitting or malforming it took none, and sending another caller's label burned that
  caller's share. Now:
  - A line of `BIM_SERVICE_TOKENS_FILE` is `<token>` (tenant `default`; files written for earlier versions keep their
    meaning) or `<tenant> <token>` (a label matching `[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}`, spaces or tabs). The tenant
    bound to the token that authenticated a request is the caller's identity, and the only key of the share.
    `bim_service.auth.Authenticator.identify()` returns that tenant (or `None`) instead of the former boolean
    `authorize()`.
  - **Rotation limit changed:** up to **2 tokens per tenant** (was 2 in total) and at most **64 tenants**; a token
    cannot appear twice, in one tenant or in two. The two tokens of a tenant share one count. Invalid files (a
    malformed line or label, a repeated token, a third token for a tenant, more than 64 tenants) stop the start with a
    message that names a line number and never a token or a label. Comparison stays constant-time over every stored token.
  - `X-BIM-Tenant` is accepted and ignored for the share; if it is well formed it is logged as `claimed_tenant` when it
    differs from the identity, and the log line's `tenant=` is now the identity. Anonymous dev mode has the single
    identity `anonymous`.
  - The global ceiling (`BIM_SERVICE_MAX_CONCURRENCY`, `BIM_SERVICE_ACQUIRE_TIMEOUT_MS`) is unchanged and independent.
  - `BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT` is unset by default instead of 2. Unset, the limit of 2 applies only when
    the tokens file names **two or more tenants**; with one tenant (a gateway, its worker and its seed sharing one
    token) it would halve the whole service, so none applies. An explicit value, 0 included, is always honoured.
    `limits.service.maxConcurrentOperationsPerTenant` in `GET /bim/v1/capabilities` now publishes the value in force
    (0 = none). `BimServiceSettings.max_concurrency_per_tenant` is `int | None`; `app.state.settings` is the effective
    settings (`configured_tenants`).
  - `contracts/openapi/bim-service.v1.json` is regenerated (the descriptions of the bearer scheme and of 429 only; no
    path, schema or status changes); the consumer fixtures were regenerated with `tools/consumer_fixtures.py` and did not
    change (they do not record the service limits).
  - `bim-client`: `HttpBim`'s `token_file` still holds only the token (the whole first line is the token). A first line
    with whitespace inside, such as the service's `<tenant> <token>` form, is refused with
    `BimServiceError("token_unavailable")` instead of being sent. `tenant=` remains an informative label.
  - Compatibility: a one-token or two-token file and a client that sends or omits `X-BIM-Tenant` keep working; what
    changes is that sharing is now by token. Deployments that relied on the header to separate callers must give each
    caller its own labelled token.

## [0.1.0] - not released

First cut. Nothing has been published, tagged or pushed: the remote repository does not exist and the license is
pending (see [`NOTICE.md`](NOTICE.md)).

### Added

- `bim-core`: the BIM v1 language (package loader, canonical JSON, expressions, Instance compiler), the evaluator,
  re-evaluation, the `bim-engine/v1` protocol and Engine compatibility, as a library with resources (JSON Schemas,
  engine contract, vendored OMG BPMN 2.0.2 XSDs) read through `importlib.resources`.
- `bim-service`: a stateless HTTP API (`/bim/v1`) over `bim-core`, with limits and service-to-service tokens.
- `bim-client`: `BimPort` with `InProcessBim` and `HttpBim`.
- Packaging: wheel and sdist for each distribution, `py.typed`, a uv workspace at the root, `license-files` with
  `NOTICE.md` and no `license` field, the `Private :: Do Not Upload` classifier.
- `tools/toolchain_json.py` (the release descriptor), `tools/smoke_installed.py` (smoke test of installed wheels with
  `python -I`), the example package `packages/bim-core/tests/fixtures/example-package/`.
- CI and release workflows under `.github/workflows/` (not run yet).

### Toolchain digests

This is the first release: there is no earlier `compilerDigest` to compare with. The digest definition was not
changed by packaging; see `docs/PACKAGING.md` for the comparison between the installed wheel, the source tree and
the sdist.
