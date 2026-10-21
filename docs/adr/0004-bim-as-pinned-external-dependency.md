Status: DRAFT for owner review (2026-10-21)

# ADR-0004: OpenBinding consumes BIM as a pinned release of `isa-group/bim-toolchain`

- Status: Proposed
- Date: 2026-10-21
- Deciders: owner (decided in the factory brief §3; not yet implemented)

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

> OPEN QUESTION: the brief names `isa-group/bim-toolchain`; `bim-toolchain/README.md` and `docs/RELEASING.md` name
> `javiercavlop/bim-toolchain`. Which owner/organisation is final?
> OPEN QUESTION: distribution channel for the pin (Git tag + `uv` git source, private package index, or wheels attached to releases)?

## Evidence

Factory brief §3; `bim-toolchain/docs/DELIVERY.md`, `bim-toolchain/docs/RELEASING.md`; current path sources in
`openbinding-gateway/pyproject.toml` (GAP).
