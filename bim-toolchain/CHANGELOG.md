# Changelog

All notable changes to the three distributions (`bim-core`, `bim-service`, `bim-client`) are recorded here. The
three are versioned together. The version follows SemVer with the digest rules of
[`docs/DIGESTS.md`](docs/DIGESTS.md); a release changes `compilerDigest` by definition, and says so below when it
changes anything else.

## [Unreleased]

### Fixed

- `POST /bim/v1/engines/validate` and `InProcessBim.validate_engine` answer an engine document whose `spec` is not
  an object with the diagnostic `{code: "engine_contract_invalid", message, pointer: "/spec"}` instead of a 500 /
  `AttributeError` raised by `bim_core.engine_contract_diagnostics` (which is unchanged). The OpenAPI schema does not change.

### Added

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
