# SPHERE → OpenBinding platform inventory

This inventory is the implementation boundary for the collaborative-platform
branch. It was refreshed on 2026-09-05 against SPHERE, SPHERE docs, SPACE and
OpenBinding. It records what is reused, adapted, redesigned or deliberately
excluded so a later implementation choice is traceable rather than accidental.

## Reference state

- SPHERE source: `356ad1129acaee4beb3c4574e389f158cb0a2eaa`.
- SPHERE docs: `107c5451e464e77a87a1f8b72dd71fa9d9e93231`.
- SPACE: `5fa4d3fd990be9477e742917f829853a1791f798`.
- space-python-client: `1ec3bce6c57fb3f7192e3d721048fa738e921ade`.
- Open SPHERE pull requests (rechecked through the GitHub API on 2026-09-05):
  #139 bulk permission drafts, #140 password recovery, #141 password change,
  #142 account deletion/cascade, #143 linter templates and #144 changelog
  workflow permissions.
- No open pull requests were present in SPHERE docs, SPACE or OpenBinding.

The PR list is queried again immediately before integration because it is a
moving input. Features are adapted from their contracts and tests, never
blindly copied from an unmerged branch.

## Product and architecture decisions

| SPHERE capability | Decision | OpenBinding interpretation |
|---|---|---|
| Public shell, Explore and dashboards | Adapt | A binding observatory centred on projects, cases, studies, engines and reproducible activity |
| Organizations and teams | Extend | Arbitrarily nested organizations, inherited roles, invitations, sponsors and unique-member accounting |
| Pricings and immutable versions | Adapt twice | Immutable BIM/case revisions in the user platform; a single externally stored operational pricing lifecycle for administrators |
| Public/private resources | Adapt | Project, case, artifact, report and publication visibility with authenticated private responses and immutable public digests |
| Collections | Redesign | Ordered, versioned curation of immutable references; collections never execute work |
| Configuration-space analysis | Redesign | Feasibility, Pareto, convergence, objectives, runtime, stability and cross-engine comparison |
| HARVEY assistant | Exclude/replace | Deterministic diagnostic actions and documentation links; no LLM dependency or fabricated result |
| API keys and entity permissions | Extend | Closed capabilities plus optional method, organization, project, resource slug and exact-engine reductions |
| Account recovery/change/delete | Include | Single-use recovery, authenticated change and safe cascade/revocation workflows |
| Linter templates | Include | BIM/qos-binding and pricing templates validated by the same schemas as execution |
| Changelog automation | Adapt | Platform, BIM/Engines and Documentation streams generated from releases and Conventional Commits |
| Team, Research and Funding pages | Adapt | Verified people, publications, grants, projects and reproducibility links stored as reviewed Git data |
| MongoDB | Exclude | PostgreSQL remains the only operational source of truth |
| Local YAML storage | Limit | Import/export, fixtures and portable packages only; never the live operational pricing |
| Public file URLs | Harden | Digest URLs with ETag/immutable cache for public artifacts; authorization + `no-store` for private content |
| Direct database administration | Constrain | Local-only Adminer profile plus audited safe maintenance endpoints |
| Simulated payment | Exclude | `Contact us / Institutional agreement`; no checkout or fictitious transactions |

## Binding-specific extrapolations

SPHERE's pricing comparison becomes a **study**: a reproducible Cartesian
product of case revisions, exact engine revisions, parameter sets and seeds.
Every cell freezes its inputs, can be retried independently and contributes to
aggregate analysis only after its canonical result is reevaluated by
OpenBinding. A collection may seed a study, but does not become one.

SPHERE's version catalogue becomes the provenance spine for BIM resources:
revisions are immutable and content-addressed, mutable aliases are short-lived,
and published reports cite exact BIM, dialect, engine, dataset and parameter
digests. This preserves the existing package → validation → dialect/profile →
IR → engine → reevaluation pipeline instead of wrapping it in a second solver.

## External pricing boundary

SPHERE is the remote source of the operational pricing under the single
organization `OpenBinding`, single slug `openbinding`, authenticated
server-to-server with `x-api-key`. Private prerelease drafts and public stable
releases share that slug; collections are not involved. SPACE owns deployed
versions and user contracts. OpenBinding persists only release metadata,
digests, audit records, migration intent and the `LIVE` pointer—never the YAML.

SPHERE's current static-file route does not authenticate the content URL even
when a version is private in its catalogue. Drafts therefore contain no secret,
private URLs never leave administrative responses, and previews are proxied
with `Cache-Control: no-store`. “Private” means catalogue/workflow privacy until
the upstream static delivery is cryptographically protected.
