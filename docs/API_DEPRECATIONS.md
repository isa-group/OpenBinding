# Removed API operations

Record of the gateway API operations that were retired and removed. M9.6 removed all of them on **2026-10-27**, with
no deprecation period and no `Sunset` date: nothing ran in production, and the owner decided to remove them at once.
The reason is [ADR-0020](adr/0020-smaller-platform.md) (smaller platform) and the owner decision of 2026-10-27.

The routes are gone, not stubbed. After removal the gateway gives its generic unrouted answer:

- **404**: the path has no remaining route; the body is `{"detail": "Not Found"}`.
- **405**: the path stays for another method (named in the table), so the answer carries an `Allow` header that lists
  only the kept method.

The retired operations no longer answer `Deprecation` or `Sunset` headers and are not marked `deprecated` in
[`openapi.json`](openapi.json). The one exception is the pricing document (`getPricingDocument`), which keeps
`deprecated: true`; it is not part of this removal. QACOBench used none of these operations. The developer tools
`tools/verify_analysis.py` and `tools/seed_analysis.py`, and the analysis hint of `tools/seed_dev.py`, were removed with
them. The data they held was exported and dropped, see [the runbook](runbooks/retired-data-export.md).

## Removed operations (41)

### Decision-space workspace

Replacement: none in the API. The trade-off set of a multi-objective run is on the run and study pages. The analysis
queue and its worker were removed too.

| Method | Path | After removal |
|---|---|---|
| GET | `/v1/analysis/sources` | 404 |
| POST | `/v1/analysis/query` | 404 |
| POST | `/v1/analysis/candidate` | 404 |
| POST | `/v1/analysis/export` | 404 |
| POST | `/v1/analysis/reports` | 404 |
| POST | `/v1/analysis/pareto` | 404 |
| GET | `/v1/analysis/pareto/{task_id}` | 404 |
| POST | `/v1/analysis/pareto/{task_id}/cancel` | 404 |

### Report editor

Replacement: none yet. Published results of study runs and collections are planned (M6.5).

| Method | Path | After removal |
|---|---|---|
| GET | `/v1/organizations/{org}/projects/{project}/reports/{report}` | 404 |
| POST | `/v1/organizations/{org}/projects/{project}/reports` | 405 (`Allow: GET`) |
| POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/freeze` | 404 |
| POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/drafts` | 404 |
| PATCH | `/v1/organizations/{org}/projects/{project}/reports/{report}` | 404 |
| DELETE | `/v1/organizations/{org}/projects/{project}/reports/{report}` | 404 |
| POST | `/v1/organizations/{org}/projects/{project}/publications` | 405 (`Allow: GET`) |

### Library catalogue

Replacement: none. Problems are versioned as a whole, and the artifact store stays internal.

| Method | Path | After removal |
|---|---|---|
| POST | `/v1/organizations/{org}/library` | 405 (`Allow: GET`) |
| GET | `/v1/artifacts/{artifact_id}` | 404 |
| PATCH | `/v1/artifacts/{artifact_id}` | 404 |
| GET | `/v1/artifacts/{artifact_id}/versions/{version_id}` | 404 |
| GET | `/v1/artifacts/{artifact_id}/drafts` | 404 |
| POST | `/v1/artifacts/{artifact_id}/drafts` | 404 |
| PUT | `/v1/artifacts/{artifact_id}/drafts/{draft_id}` | 404 |
| POST | `/v1/artifacts/{artifact_id}/drafts/{draft_id}/seal` | 404 |
| POST | `/v1/artifacts/{artifact_id}/versions/{version_id}/publish` | 404 |
| POST | `/v1/artifacts/{artifact_id}/versions/{version_id}/withdraw` | 404 |

### Project library

Replacement: none. Problems are versioned as a whole, and the artifact store stays internal.

| Method | Path | After removal |
|---|---|---|
| PUT | `/v1/organizations/{org}/projects/{project}/library/{artifact_id}` | 404 |
| GET | `/v1/organizations/{org}/projects/{project}/library` | 404 |
| DELETE | `/v1/organizations/{org}/projects/{project}/library/{artifact_id}` | 404 |

### Project resources

Replacement: none. Problem versions and collections.

| Method | Path | After removal |
|---|---|---|
| POST | `/v1/organizations/{org}/projects/{project}/resources` | 405 (`Allow: GET`) |
| GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions/{revision}` | 404 |
| POST | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions` | 405 (`Allow: GET`) |
| GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | 404 |
| PATCH | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | 404 |
| DELETE | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | 404 |

### Sponsorship

Replacement: none. Administrators assign the RESEARCH or LAB plan in SPACE. Only the caller can become billing sponsor
(below).

| Method | Path | After removal |
|---|---|---|
| POST | `/v1/admin/organizations/{organization_id}/sponsor` | 404 |
| GET | `/v1/sponsor-proposals/{proposal_id}` | 404 |
| GET | `/v1/users/me/sponsor-proposals` | 404 |
| GET | `/v1/organizations/{org}/sponsor-proposals` | 404 |
| POST | `/v1/sponsor-proposals/{proposal_id}/accept` | 404 |
| POST | `/v1/sponsor-proposals/{proposal_id}/decline` | 404 |
| POST | `/v1/sponsor-proposals/{proposal_id}/cancel` | 404 |

## Kept operations (12)

These stay, tested, because kept screens use them.

| Method | Path | Why |
|---|---|---|
| GET | `/v1/organizations/{org}/projects/{project}/reports` | project data, publications screen |
| GET | `/v1/organizations/{org}/library` | study builder, version picker |
| GET | `/v1/artifacts/{artifact_id}/versions` | study detail, version picker |
| GET | `/v1/artifacts/{artifact_id}/versions/{version_id}/content` | study builder |
| POST | `/v1/artifacts/resolve` | case revision |
| GET | `/v1/organizations/{org}/projects/{project}/resources` | resources screen |
| GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions` | resources screen |
| GET | `/v1/jobs/{job_id}/analysis/neighborhood` | run page |
| GET | `/v1/organizations/{org}/projects/{project}/publications` | publications screen |
| DELETE | `/v1/organizations/{org}/projects/{project}/publications/{publication}` | withdraw a publication |
| GET | `/v1/explore/publications` | Explore |
| GET | `/v1/resolve/{kind}/{digest_value}` | permanent links (and its `/content` sibling) |

Existing publications keep answering at `GET /v1/resolve/{kind}/{digest_value}`, in the project publication list and
in Explore. No kept operation creates a new publication from a report or makes an artifact version public; package
import and export (`/package`) are unchanged.

## Sponsor rule change

`PATCH /v1/organizations/{org}` with `billing_sponsor_user_id` no longer creates a sponsor proposal. An OWNER may name
only themselves; naming anybody else answers `422 sponsor_must_be_caller` (see [ERRORS.md](ERRORS.md)). The request
field `replace_pending_proposal` was removed, so a client that sends it gets `422 validation_error`. The details are in
[ACCOUNTS_AND_PLANS.md](ACCOUNTS_AND_PLANS.md).
