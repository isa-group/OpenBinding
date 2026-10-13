# Changelog

All notable changes to the three distributions (`bim-core`, `bim-service`, `bim-client`) are recorded here. The
three are versioned together. The version follows SemVer with the digest rules of
[`docs/DIGESTS.md`](docs/DIGESTS.md); a release changes `compilerDigest` by definition, and says so below when it
changes anything else.

## [Unreleased]

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

The directory/ZIP work below changes **no** digest: no file of `bim_core` was edited (tests, `tools/`, goldens, CI and
documentation only), so `compilerDigest` and every `irDigest` are as before, and the version stays `0.1.0`.

### Known issue (documented, not fixed)

- `bim-core`: the IR of a package depends on the order in which it declares JSON object members, so the package compiled
  from its **canonical ZIP** (`InstancePackage.to_zip()`, members sorted) differs from the one compiled from its
  directory or from the ZIP of its bytes whenever the package declares eligible candidates, constraints or placement
  demands out of alphabetical order: **64 of the 82 corpus packages** have another `irDigest` and semantic digest (18
  are equal), in `spec.eligibility`, `spec.constraints`, `spec.placement` and `spec.sourceMap` only. `packageDigest` is
  identical in every form. The enumeration order of the file system and of the ZIP entries plays no part. A canonical
  order would move the semantic digest recorded in `golden/bim_baseline` for those 64 packages and the order (and, for
  sampled evaluations, the summaries) of their evaluations: a MAJOR change by `docs/DIGESTS.md`, not made. The
  divergence is pinned by `golden/bim_core/zip_equivalence.json` and by strict `xfail` tests that carry the cause. See
  `docs/DIGESTS.md#directory-raw-zip-and-canonical-zip`.

### Fixed

- `POST /bim/v1/engines/validate` and `InProcessBim.validate_engine` answer an engine document whose `spec` is not
  an object with the diagnostic `{code: "engine_contract_invalid", message, pointer: "/spec"}` instead of a 500 /
  `AttributeError` raised by `bim_core.engine_contract_diagnostics` (which is unchanged). The OpenAPI schema does not change.

### Added

- Tests without the corpus: `packages/bim-core/tests/test_zip_dir_equivalence.py` (synthetic packages written by
  `synthetic_packages.py`: directory, raw ZIP in any entry order and canonical ZIP compared on semantic digest, IR,
  `irDigest`, `packageDigest` and eligibility order; the divergence above is a strict `xfail`) and
  `test_limits_near_boundary.py` (`Limits` at their boundary for ZIP, directory and in-memory packages, with bounded
  memory and time near the limit).
- `tools/baseline_core.py` compiles every package from its directory, from the raw ZIP of its bytes and from its
  canonical ZIP and writes `golden/bim_core/zip_equivalence.json`; `--check` fails if the package compiled from its
  ZIP (the production route) is not the one the goldens recorded from its directory. The golden is new; no existing
  golden was regenerated.
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

- `bim-client`: `HttpBim` no longer raises `BimOperationUnavailable` for those four operations; it sends them.
  `BimOperationUnavailable` stays exported (compatibility) but nothing raises it.

The version numbers are unchanged: `0.1.0` has not been released, so these additions belong to it.

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
