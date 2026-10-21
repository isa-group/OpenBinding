Status: DRAFT for owner review (2026-10-21)

# ADR-0001: Record architecture decisions

- Status: Accepted
- Date: 2026-10-21
- Deciders: owner (factory brief §4)

## Context and problem

Architectural decisions of OpenBinding are scattered across `docs/ARCHITECTURE.md`, `docs/qa/*.md`, prior agent plans
and commit messages. Agents working autonomously need a single, reviewable record of what was decided and why.

## Decision

Record architecturally significant decisions as Markdown Architecture Decision Records (MADR) in `docs/adr/`, numbered
`NNNN-title.md`, one decision per file, with status `Proposed | Accepted | Deprecated | Superseded by ADR-NNNN`.
Agents may draft ADRs as `Proposed`; only the owner sets `Accepted`, `Deprecated` or `Superseded`. An accepted ADR is
never edited except to change its status and add a link to the superseding ADR.

## Consequences

- Reviewers (arch-reviewer) check changes against accepted ADRs (`REVIEW.md`).
- ADRs 0002–0013 below were reverse-engineered from the baseline; each cites the evidence that the decision is in force,
  and is `Proposed` where the code does not show it yet.

## Evidence

Factory brief §4 (MADR under `docs/adr/`).
