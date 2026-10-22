Status: PROPOSED for owner review (2026-10-22)

# ADR-0016: Extensible language — profiles that extend profiles, adapter tiers and one language API

- Status: Proposed
- Date: 2026-10-22
- Deciders: owner

## Context

BIM v1 already separates a core container from Profiles and Dialects and lets dialects be submitted and approved.
Three things do not match the owner's intent: a profile cannot extend another one, so placement is special-cased
inside the core profile (`BindingProblem.spec.placement`) instead of being an extension that changes compilation;
adapters must be deployed code, so a dialect cannot really be developed and installed by someone else; and the
language API is spread over `/v1/profiles`, `/v1/dialects`, `/v1/resources`, `/v1/schemas`, `/v1/catalog`,
`/v1/examples` and `/v1/validate`. The CLASP paper defines placement exactly as an extension of the candidate model
(`M′_C = (P, C, F, R, L)`) with a pre-solve compile step; the quantum paper shows that other domains need no
extension at all.

## Decision

1. Profile manifests gain `extends` (single inheritance). A child inherits everything, may add roles, resource types,
   capability values, limit names, output sections, evaluation semantics and compile hooks, and may tighten but never
   loosen cardinalities or change the meaning of a parent field.
2. Placement is re-declared as `qos-binding-placement/v1` extending `qos-binding/v1`, keeping its IR shape so engines,
   goldens and digests do not change. Its resource type sits in the `candidateCatalog` role.
3. Adapters have three tiers: built-in code (tier 0), declarative mappings evaluated by a sandboxed transform engine
   (tier 1) and adapter services behind `bim-adapter/v1` verified like federated engines (tier 2).
4. One lifecycle for extensions (draft, submitted, checked, approved, installed, deprecated, retired) and one API under
   `/v1/language`, keeping the old routes as deprecated aliases for one minor release.
5. A developer kit (`bim-ext`) in `bim-toolchain`.

## Consequences

- Engines declare the profiles they support; capability matching includes the profile chain.
- The canonical evaluator must implement the semantics of every installed profile (constitution 17.3), so new
  semantics are always reviewed code or declarative expressions the evaluator understands.
- `extends` is a BIM MINOR change and the deprecations are API changes: both go through CRPs.

## Evidence

`docs/BIM_V1.md`, `docs/PLACEMENT.md`, `docs/BPMN.md`, `docs/ARCHITECTURE.md` §8, `ROADMAP.md` M5;
CLASP (ICSOC 2026) and quantum resource selection (ICSOC 2026) papers.
