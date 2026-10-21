Status: DRAFT for owner review (2026-10-21)

# ADR-0004: OpenBinding consumes BIM as a pinned release of `isa-group/bim-toolchain`

- Status: Accepted (owner decision 2026-10-21; implementation pending)
- Date: 2026-10-21
- Deciders: owner

## Context and problem

`bim-toolchain/` lives inside this repository and the gateway depends on it through editable path sources
(`openbinding-gateway/pyproject.toml` `[tool.uv.sources]`). A path dependency lets a platform change silently alter
language semantics and makes the IR toolchain of a deployment ambiguous.

## Decision

After `develop` is unified, move `bim-toolchain/` to the private repository `isa-group/bim-toolchain` (history-preserving
export, `bim-toolchain/tools/export_repo.py`). OpenBinding then depends on an exact released version/tag of `bim-core`
and `bim-client` (and runs the pinned `bim-service` image in `http` mode), never on a path or editable install.
Consumer-contract tests (`contracts/consumers/openbinding/`) run in the CI of both repositories; upgrading the pin is an
explicit change.

## Consequences

- Language changes follow BIM's own INTENT/constitution/specs and SemVer.
- The OpenBinding corpus (`examples/`) remains the source of the `openbinding_corpus` test tier; how BIM CI obtains it is open.
- The OMG BPMN XSD redistribution question must be settled before publication.

- The repository is the private `isa-group/bim-toolchain`; OpenBinding pins a release tag. `bim-toolchain/README.md` and
  `bim-toolchain/docs/RELEASING.md`/`DELIVERY.md` still name `javiercavlop/bim-toolchain` and must be corrected.

## Evidence

Factory brief §3; `bim-toolchain/docs/DELIVERY.md`, `bim-toolchain/docs/RELEASING.md`; current path sources in
`openbinding-gateway/pyproject.toml` (GAP).
