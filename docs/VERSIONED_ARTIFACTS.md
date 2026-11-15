# Organization artifact library

> Being reduced. The library as a catalogue (organization library, project resources, project
> library, its pages and endpoints) retires; the versioned-artifact store described here stays as the
> repository's internal storage of sealed parts, and sealed problem versions keep their exact references.

The artifact cutover is in progress. The shared library, private sealing, version publication, exact BIM references and case materialization are implemented. Study definitions are stored exclusively in library versions; project study contexts select a version, and each run pins its original definition with a restrictive FK. Library Study versions validate typed definitions and protect exact case references. Reports, publications and collections were removed in F0a (see below). External citation metadata remains a declaration, not proof that an external dataset is available.

## Identity and content

`Artifact` owns a stable UUID and `(namespace, name)`. Its namespace is the owning organization UUID, independent of editable slugs. Display metadata can change. `ArtifactDraft` is editable with a required optimistic revision number. `ArtifactVersion` is sealed even when private; SQL triggers reject updates and deletion. Publication is a separate record for an exact version. Withdrawal removes discovery without destroying historical access to that published version.

`Blob` is content-addressed storage owned by an organization (`modules/shared/blobs.py`): one row per `(organization, digest)`, holding the uploaded `.bim.zip` of a problem revision or the bytes of a sealed library version. There are no project file routes; a blob is reached through what stores it.

Blob rows and files stay when a problem is deleted; nothing deletes a blob through the API.

The portable resource reference is:

```json
{"namespace":"organization-uuid","name":"catalog","version":"2","versionDigest":"sha256-<64 hexadecimal digits>"}
```

`contentDigest` hashes canonical JSON or normalized UTF-8 text. `versionDigest` hashes the version manifest, including the technical address, label, content hash, media type, exact contracts and dependencies. It is not interchangeable with the existing BIM contract reference's `digest`. Equal content under different identities remains different versions.

## API workflow

1. `POST /v1/organizations/{org}/library` creates an identity.
2. `POST /v1/artifacts/{id}/drafts` supplies content, MIME, contracts and fixed dependencies; `based_on_id` records its source version, including a fork source.
3. `PUT /v1/artifacts/{id}/drafts/{draft}` updates with the last observed `revision`. Conflicts return 409.
4. `POST /v1/artifacts/{id}/drafts/{draft}/seal` validates and seals. Labels default to the server ordinal. Retrying the same seal is idempotent; using its label for different content conflicts.
5. `PUT /v1/organizations/{org}/projects/{project}/library/{id}` associates a project with the identity.
6. `POST /v1/artifacts/{id}/versions/{version}/publish` exposes that version. Fixed dependencies must already be public. `/withdraw` records withdrawal.

GET identity, drafts, versions and version content endpoints support the library UI. `GET /v1/organizations/{org}/projects/{project}/library` lists project uses; `DELETE` on its `/{id}` association removes only that use, preserving versions and historical case references. Library and blob endpoints use the `artifacts:read` / `artifacts:write` API-key grants in addition to organization roles. UUID-based library lookups also enforce organization and artifact-name API-key boundaries. Project-bound keys cannot acquire organization-wide library authority; use an organization-bound key for library editing and resolution. `POST /v1/artifacts/resolve` resolves a complete reference and checks the manifest hash. Private versions are organization scoped; public versions can be consumed across organizations. Pricing remains the platform's operational SPHERE/SPACE integration.

See [OpenAPI](openapi.json) for request and response schemas.

## Cases and contracts

A `BindingCase` is a problem of an organization. Its revisions are the uploaded `.bim.zip` packages themselves, sealed with their `package_digest` (the toolchain's canonical package digest), `instance_digest`, file list and resource digests; there is no materialized composition of library resources. See [ARCHITECTURE.md](ARCHITECTURE.md) §4.1 (module `problems`).

`spec.contracts` selects an exact Profile and Dialects using each installed contract's `{namespace,name,version,digest}`. Multiple versions of one family may be installed. Compilation never substitutes a nearby release for an unavailable exact contract. Schema-declared `{resource,id}` references are rebound in a derived document; original bytes are preserved. Arbitrary JSON/XML string replacement is not performed.

The Workbench is scoped by organization, problem and revision (`/app/{org}/workbench?problem=&revision=`). The study builder lists every revision of the organization's problems.

The pure language core that computes these digests is packaged separately; see [BIM core](BIM_CORE.md) for its boundary and why its bytes must not change outside a contract release.

Built-in Profile and Dialect releases use SemVer build metadata derived from the
complete contract: `1.0.0+<base32-sha256>`. Adapter labels also include their binary
digest. The full hash is retained, with labels fitting the 64-character version
limit. Changing schemas or deployed compiler bytes therefore creates a different
exact version; a build cannot silently replace an earlier `1.0.0` contract.
The suffix has no compatibility ordering, and consumers compare the full reference.
Trusted extension registration rejects a duplicate namespace/name/version even
inside a selected compilation context. Registry manifests are copied on install
and discovery so callers cannot mutate an installed contract through a shared dict.

## Revisions and compilations

A revision keeps the package bytes; its compilations keep the IR, the source map and the analysis, one row per
toolchain (`problem_compilations`, insert-only). Reading the compilation of a revision under a new toolchain compiles
it again and adds a row; a package the toolchain now refuses is `422 revision_not_recompilable`. A job names the
revision and the compilation it ran and never copies the IR.

Verifiable means that retained bytes match their hashes. Recompilable additionally requires exact schemas and
adapters. Reexecutable additionally requires a compatible engine deployment.

## Development cutover and outstanding integration

The schema, library tables included, is the one-revision Alembic baseline (`tools/rebaseline.py`); the sealing triggers are declared once in `db/triggers.py`. Independent PostgreSQL connections verify concurrent idempotent sealing, conflicting version labels and optimistic draft edits.

The project-resource HTTP surface now delegates to the common artifact identities
and sealed versions while retaining its historical response envelope for package
clients. New writes no longer create `ProjectResource` rows. The BIM registered-resource registry was removed
in F0a: an Instance resolves only package files and organization library versions.
Portable imports use the library closure as the source of truth as well: the
legacy `resources` array is checked as an index and never materialized into the
retired tables. Packages no longer carry collections.
Open items are limited to migrating old stored rows, extending exact editor
discovery, recursively closing foreign portable dependencies, and broadening
seed/E2E coverage. They do not affect the immutability or reproducibility
guarantees of newly-created library versions.


## Scientific definition content

Library studies use `apiVersion: "openbinding/study/v1"`, `cases` containing
`{caseRevisionId, compositionDigest}`, exact `engines` (including `mode`),
`parameter_sets` and `seeds`. Sealing checks the existing study matrix bounds,
engine options, the package digests of the revisions (`compositionDigest`) and organization
ownership. Case revisions from different projects in that organization are allowed.

Study case members have immutable FK rows in `artifact_case_references`. Study creation takes the exact case
revisions in `definition.case_revision_ids`; collections, and seeding a study from
one, were removed in F0a.

Publication requires referenced Engine contracts to be publicly resolvable. It also checks that referenced cases belong to public projects, have closed
artifact compositions and consume only published resource versions. Making a
project public alone cannot publish its resources. The native content schemas are
included in OpenAPI under `x-artifact-content-schemas`.

## Study version selection and history

`POST .../studies` accepts either a new `definition` or an existing
`definition_version_id`, never both. Selecting an accessible library Study version
allows multiple projects to share a definition without copying its cases or payload.
`PATCH .../studies/{study}` selects another sealed version of that same artifact.
`POST .../studies/{study}/runs?definition_version_id=...` selects an exact historical
version; every run records it even when the query parameter is omitted. Engine
grants and analytics use the run's version, independently of later study updates.

Studies and runs point at their definition version by FK. Run identity, definition and matrix hashes cannot
be updated in SQL; run deletion is rejected. Studies with runs can be archived
using `PATCH {"archived": true}` and restored, preserving history. Lists omit
archived studies unless `include_archived=true`; archival prevents new runs.
The frontend exposes shared-version selection, adoption and archive/restore.
The triggers of `db/triggers.py` also protect cell identity, case revision, Engine reference,
parameters, seed and fingerprint from SQL updates and rejects cell deletion.
Operational state, retry job assignment and metrics remain writable.

`POST .../runs/{run}/cells/{cell}/result` attaches an existing job to a cell. The job
must belong to the caller (otherwise `404`), be terminal (`409 job_not_finished`), have a
result when completed (`409 job_result_missing`), not already be the result of another cell
(`409 job_already_attached`), and be a faithful execution of the cell: its BIM package
must be the one pinned by the cell's case revision, its Engine namespace/name/version/digest
and (when the cell pins one) mode must match, and its seed must equal the cell's. A seed
absent from the job counts as a mismatch when the Engine mode accepts one. Otherwise the
answer is `409 cell_job_mismatch`, whose `fields` names each differing identity
(`case_revision`, `engine`, `mode`, `seed`) and whose `details` gives the `cell` and `job` values.
The cell's `parameters` and the execution `optimization` are not compared.

Project export includes both the selected and historical run definition versions.
Import verifies each run's Cartesian matrix, cell inputs and fingerprints against
its sealed definition; it does not remap a historical cell while retaining its old
fingerprint. Import defers case-dependent library versions until their exact case revisions
exist, and preserves revision UUIDs when they are absent locally. Export traverses
both artifact dependencies and exact case references, including cases from other
projects. Foreign namespaces still require resolution from their owner.

Analysis seed galleries are non-executable Dataset versions with
`apiVersion: "openbinding/analysis-gallery/v1"`. Their fixture matrices remain
inspectable; the study execution endpoint rejects them as evidence-only data.

## Reports and publications (removed)

Reports, their editions, project publications and Explore were removed in F0a (no route, service, screen or seed
creates or reads them); their tables, with the collections and the report evidence, were dropped by the F0b baseline. A study is exported instead (the CSV of the
Results tab). Sealed versions no longer carry evidence (`manifest.evidence` is always empty), and package export and
import no longer carry reports, publications or job evidence.

A PostgreSQL volume built from an older baseline is refused; follow "Reset the dev database" in the README.

Import checks identity collisions and retains source UUIDs when absent.
