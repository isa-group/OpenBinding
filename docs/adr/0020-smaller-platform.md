Status: PROPOSED for owner review (2026-10-22)

# ADR-0020: A smaller platform

- Status: Proposed; the retirements of decision 2 were decided by the owner on 2026-10-22 (INTENT D8)
- Date: 2026-10-22
- Deciders: owner

## Context

The audit at 912648c counted 86 routed screens and 208 API operations. Several areas duplicate what a run, a study
or a problem version already shows, and no journey of `INTENT.md` §2 needs them:

- the decision-space workspace (`/app/analysis`: weights, influence cells, duals, hulls, hypervolume, journey replay,
  shortlists, saved draft decisions). The only part a journey needs is the trade-off set of a multi-objective run;
- the report editor, with report documents, editions and publications. The text of a paper lives in the paper; what
  its readers need is a frozen, citable result they can open and verify;
- the library as a catalogue (organization library, project resources, project library). It is a second versioned
  catalogue beside problem versions, whose parts are already sealed and addressed by digest;
- the composer, a second editor beside the workbench;
- organization sponsorship, made redundant by per-account SPACE contracts (ADR-0015).

Screens also label cards, lists, versions, runs, studies and reports with SHAs, digests and fingerprints
(`sha256-2222…2222`, "edition fingerprint"), which people can neither read nor compare.

On 2026-10-22 the owner asked to keep only what is practically useful for the pillars.

## Decision

1. Journeys decide what exists. A screen, an endpoint or a concept exists only if a journey of INTENT §2 needs it
   (INTENT principle 12, constitution 6.8). The surface budget is at most 45 routed screens, and each journey
   completes in at most five (INTENT O12).
2. Retire the decision-space workspace, the report editor, the library as a catalogue, the composer and sponsorship.
3. Keep what a journey needs from them:
   - the trade-off set moves to the run and study pages;
   - "Publish" freezes a study run or a collection version into a published result with a permanent link, a
     citation and a Zenodo-ready export;
   - problems are edited and versioned as a whole, duplicated, or generated into collections; the versioned-artifact
     store stays as the repository's internal storage of sealed parts (problem resources, study definitions,
     execution configurations);
   - administrators assign RESEARCH or LAB in SPACE.
4. People read names, machines read digests (INTENT principle 13, constitution 15.5). Screens show names, version
   numbers and dates. The API keeps every digest. A digest is shown only on Verify, in citation panels and in export
   manifests.
5. Retire before moving (`docs/ARCHITECTURE.md` §4.3, step 0). Screens go first, then endpoints, after one minor
   release with `Deprecation` and `Sunset` headers (CRP). Code goes next. Data goes last, by a CRP migration that
   keeps every sealed digest valid.

## Consequences

- The budget of 45 screens (86 today) is reached by these retirements together with the merges of INTENT §6:
  workbench and composer, resolve and verifier, examples into Explore.
- Offenders 5, 7 and 11 of the render-never-dump allow-list disappear with their screens (ADR-0014).
- The `analysis` Dramatiq queue and its worker retire with the decision-space workspace.
- API clients of the retired endpoints get one minor release of notice. QACOBench does not use them.
- Sealed problem versions keep referencing their parts by exact digest and compile to the same IR.
- Existing publications keep their permanent links as read-only published results, so nothing citable is lost.
- Pricing 0.2.0 drops the features that only the retired areas used: advanced analytics, the reproducibility
  archive, institutional branding and the limits across sponsored subtrees (`docs/pricing/`).

## Evidence

- `INTENT.md` §2, §4 (principles 12 and 13), §6, §12 (D3, D8)
- `docs/ARCHITECTURE.md` §4.1, §4.3, §5.2–§5.4, §7.4, §10
- `ROADMAP.md` M2.4, M2.7, M6.5, M9.6
- `docs/analysis/binding-decision-workspace.md`
- `docs/VERSIONED_ARTIFACTS.md`
