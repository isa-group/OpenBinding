Status: PROPOSED for owner review (2026-10-22)

# ADR-0018: Problem-centred vocabulary in the UI; API v1 unchanged

- Status: Proposed
- Date: 2026-10-22
- Deciders: owner

## Context

The product is a repository of binding problems, but the UI speaks of cases, revisions, snapshots, library
artifacts, project resources and jobs. Renaming the HTTP resources would break clients (QACOBench, scripts).

## Decision

The UI and new documentation use the glossary of `INTENT.md` §5 (Problem, Problem version, Component, Collection,
Run, Study, Report, Publication, Engine, Engine deployment, Profile, Dialect, Plan). The `v1` API keeps its resource
names; its documentation maps both. A `v2` with the new names is a separate owner decision.

## Consequences

- One mapping table instead of a breaking migration; screens and URLs move to the new names with redirects.

## Evidence

`INTENT.md` §5–6, `ROADMAP.md` M2.6.
