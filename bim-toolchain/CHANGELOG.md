# Changelog

All notable changes to the three distributions (`bim-core`, `bim-service`, `bim-client`) are recorded here. The
three are versioned together. The version follows SemVer with the digest rules of
[`docs/DIGESTS.md`](docs/DIGESTS.md); a release changes `compilerDigest` by definition, and says so below when it
changes anything else.

## [Unreleased]

Nothing yet.

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
