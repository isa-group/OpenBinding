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
| Pricings and immutable versions | Adapt (revised) | Immutable BIM/case revisions in the user platform. Pricing lifecycle: not in OpenBinding; it lives in the remote SPHERE/SPACE consoles and is read-only here (see below) |
| Public/private resources | Adapt | Unified Resolver (`/v1/resolve/{kind}/{digest}`) with offset pagination and privacy guarantees (see [RESOLVER_AND_VERIFIER.md](RESOLVER_AND_VERIFIER.md)); project, case, artifact, report and publication visibility |
| Collections | Redesign | Ordered, versioned curation of immutable references; collections never execute work |
| Configuration-space analysis | Redesign | Feasibility, Pareto, convergence, objectives, runtime, stability and cross-engine comparison |
| HARVEY assistant | Exclude/replace | Deterministic diagnostic actions and documentation links; no LLM dependency or fabricated result |
| API keys and entity permissions | Extend | Closed capabilities plus optional method, organization, project, resource slug and exact-engine reductions |
| Account recovery/change/delete | Include | Single-use recovery, authenticated change and safe cascade/revocation workflows |
| Linter templates | Include | BIM/qos-binding and pricing templates validated by the same schemas as execution |
| Changelog automation | Adapt | Platform, BIM/Engines and Documentation streams generated from releases and Conventional Commits |
| Team, Research and Funding pages | Adapt | Verified people, publications, grants, projects and reproducibility links stored as reviewed Git data |
| MongoDB | Exclude | PostgreSQL remains the only operational source of truth |
| Local YAML storage | Limit | Fixtures and portable packages only (`space/pricing/openbinding.yml`); never the live operational pricing |
| Public file URLs | Harden | Content resolution via `/v1/resolve/{kind}/{digest}/content` with ETag/immutable cache for public items and `private, no-store` for authenticated assets |
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

> **Status update.** The table above and the reference state are the
> 2026-09-05 inventory and are kept as a record of what was decided then. The
> boundary below is the current one; where the two differ, this section wins.

SPHERE and SPACE are **remote** services (`https://space.score.us.es` for SPACE;
`SPHERE_URL` for SPHERE) administered in their native consoles. OpenBinding does
not host them, edit their pricing, publish releases or renew contracts itself:

- It *shows* the account's plan, permissions and links to the consoles.
- It *reads* the published pricing read-only from SPHERE under the single
  organization `OpenBinding`, slug `openbinding`, server-to-server with
  `x-api-key` (`sphere_client.py`, `pricing_catalog.py`).
- It *delegates* account creation and plan changes to the official SPACE client
  with a `MANAGEMENT`-scoped key (`space_client/space.py`).
- It persists release metadata, digests and the `LIVE` pointer, never the YAML.

There is no local SPACE stack and no pricing administration console in
OpenBinding. Local files under `space/` hold only the pricing fixture used by
tests and development.

**Development scope.** The development pricing is **private** and the
development service is a different service from the production one, but both sit
inside the *same organizations*. A shared organization does not isolate
credentials, so a development key is high-risk (see the README).

**Code that predates this decision.** The gateway still contains modules from
the earlier pricing-release workflow: `routes/pricing.py` (it imports
`SpaceDeploymentClient`; its public `GET /v1/pricing` is marked deprecated and
the admin router exposes at least `POST /v1/admin/pricing/validate`),
`space_client/deployments.py`, and the contract-renewal and drained-release
sweeps that `jobs/reconciler.py` calls (`access/contracts.py`). I did not
trace which of these remain reachable. Removing them is **pending work**, not
something this document promises.

SPHERE's static-file route does not authenticate the content URL even when a
version is private in its catalogue. “Private” therefore means catalogue and
workflow privacy until the upstream static delivery is cryptographically
protected; drafts must not contain secrets.

## Third-party FaaS pricings

`pricings/{aws,azure,gcloud}` are Pricing2Yaml documents of AWS Lambda, Azure
Functions and Google Cloud Run functions. They are third-party offerings that BIM
experiments analyse to derive candidate costs (`pricings/README.md`); they are
not OpenBinding plans and have nothing to do with the SPHERE/SPACE pricing above.
