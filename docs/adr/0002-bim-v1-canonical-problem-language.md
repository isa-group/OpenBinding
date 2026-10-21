Status: DRAFT for owner review (2026-10-21)

# ADR-0002: BIM v1 is the canonical problem language, compiled to one IR

- Status: Accepted
- Date: 2026-10-21 (recorded; decision predates this record)
- Deciders: owner

## Context and problem

Engines historically consumed different input formats, which made results hard to compare and reproduce.

## Decision

All problems are written as BIM v1 packages (an `Instance` that selects an installed Profile, plus resources typed by
installed Dialects). The toolchain compiles a package to exactly one canonical, digest-addressed `BindingProblem` IR
declared by the Profile (`qos-binding/v1` is the only executable Profile in v1). Engines never see source packages.
Packages are stored as directories in Git and transported as deterministic `.bim.zip` archives.

## Consequences

- One contract for every engine; equal inputs produce equal IR (`irDigest`) whatever the package form (since 0.2.0).
- Language evolution follows SemVer of the toolchain; semantic changes are MAJOR (ADR-0004, `bim-toolchain/constitution.md`).
- Out of scope for the Profile: scheduling, probabilistic QoS, risk, telemetry, runtime adaptation.

## Evidence

`docs/BIM_V1.md`, `schemas/bim/v1/*.schema.json`, `tools/check_bim_corpus.py --expected 82` (CI `bim-corpus`),
`bim-toolchain/docs/CONTRACT.md`, `docs/qa/IR_NORMALIZATION.md`.
