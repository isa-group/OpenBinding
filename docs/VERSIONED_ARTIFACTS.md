# Organization artifact library

> Being reduced. The library as a catalogue (organization library, project resources, project
> library, its pages and endpoints) retires; the versioned-artifact store described here stays as the
> repository's internal storage of sealed parts, and sealed problem versions keep their exact references.

The artifact cutover is in progress. The shared library, private sealing, version publication, exact BIM references and case materialization are implemented. Study definitions are stored exclusively in library versions; project study contexts select a version, and each run pins its original definition with a restrictive FK. Library Study and Collection versions validate typed definitions and protect exact case references. Reports and publications were removed in F0a (see below). The specialized Collection routes still use their earlier model. External citation metadata remains a declaration, not proof that an external dataset is available.

## Identity and content

`Artifact` owns a stable UUID and `(namespace, name)`. Its namespace is the owning organization UUID, independent of editable slugs. Display metadata can change. `ArtifactDraft` is editable with a required optimistic revision number. `ArtifactVersion` is sealed even when private; SQL triggers reject updates and deletion. Publication is a separate record for an exact version. Withdrawal removes discovery without destroying historical access to that published version.

`Blob` replaces the former file-storage meaning of `Artifact`. Project file operations use `/v1/organizations/{org}/projects/{project}/blobs`. They do not create editorial identities. Deduplication of bytes does not confer access or merge artifact identities. Maintenance excludes blobs referenced by versions and retains shared files while any blob row uses them.

`DELETE .../blobs/{digest}` needs ADMIN on the project and is refused with `409 blob_in_use` while the project has sealed or revisioned elements that depend on that digest: sealed library versions (`Collection` ones counted apart), case revisions and their snapshots, historical collection revisions and items, and project-resource revisions. The body lists only kinds and counts, `{"references": [{"type": "case_revision", "count": 2}, ...]}`, never names. The lookup runs on the indexed digest columns (`content_digest`, `digest`, `target_digest`, `package_digest`) of the project's own elements, not over the whole project. Blobs backing a library version are organization-level and cannot be deleted from a project at all.

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

A `BindingCase` describes the experiment. Revision creation accepts `resources`, each containing `role`, local `alias`, an exact `artifact` reference and optional `bindings`. The backend resolves these versions, checks their exact Dialects, validates the whole composition and materializes the executable snapshot. The revision stores references; its digest covers the document, snapshot package and resource hashes, and ordered resource uses. A changed catalog changes the composition even when the source index is otherwise identical.

`spec.contracts` selects an exact Profile and Dialects using each installed contract's `{namespace,name,version,digest}`. Multiple versions of one family may be installed. Compilation never substitutes a nearby release for an unavailable exact contract. Schema-declared `{resource,id}` references are rebound in a derived document; original bytes are preserved. Arbitrary JSON/XML string replacement is not performed.

The workbench is scoped by user, project path, case and revision. Permanent case links carry the selected revision. The study builder lists every executable case revision. The default QoS forms require the matching `apiVersion`; other languages use expert editing.

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

## Snapshots and portable packages

Snapshots retain compiled IR, source bytes and exact contract descriptors. Reuse includes the compilation digest. Snapshot jobs use the stored IR and reject unavailable exact contracts. Snapshot inspection and archive download require ownership or membership in an organization consuming the snapshot through a case.

Project packages include case snapshots and dependency-ordered library versions. They also include accessible sealed versions of explicitly associated project artifacts, even before any case consumes them; import restores those associations. Unsealed drafts are not release inputs and are excluded. Import verifies package, content, manifest, composition and compilation digests. Existing accessible versions are reused. Import does not grant ownership of a foreign namespace: missing external identities must be resolved from their owner. The current importer requires the exact compilation toolchain; offline import with verification alone remains pending. It does not silently reinterpret a historical snapshot.

Verifiable means that retained bytes match their hashes. Recompilable additionally requires exact schemas and adapters. Reexecutable additionally requires a compatible engine deployment. A remote endpoint's registration hash does not prove the binary currently running there, and time-limited algorithms need not reproduce numerically identical results.

## Reusable execution settings

An `ExecutionConfiguration` version contains an exact `engine` contract, an
explicit `mode`, requested `options`, and optionally an exact `registration`.
`POST /v1/jobs` accepts `{ "snapshot": "uuid", "configuration": ArtifactRef }`.
It rejects combining the version with inline engine, registration, mode or options.
The workbench provides the common configuration version selector.

The job pins `configuration_version_id` with a restrictive FK and SQL immutability.
Its provenance stores the portable configuration reference, `requestedOptions`,
effective `options`, selected registration and applied limits. Quota clamping never
edits the sealed configuration. Idempotency distinguishes exact configurations,
including when their effective options happen to coincide. Project packages retain
configuration versions used by exported jobs and verify their provenance on import.
Migration `b9c0d1e2f3a4` adds this pin without recreating SQLite's existing job triggers.
Study matrices and analysis requests still record their effective options inline;
execution jobs can already pin an `ExecutionConfiguration` version explicitly.

## Development cutover and outstanding integration

Migration `b3c4d5e6f7a8` follows the existing head, renames file storage to `blobs`, adds library tables and changes snapshot uniqueness. Its downgrade deliberately refuses to discard sealed history. SQLite upgrade-chain tests exercise a fresh database. The same migration chain and library/composition/portability checks have also passed against an isolated local PostgreSQL database. Independent PostgreSQL connections verify concurrent idempotent sealing, conflicting version labels and optimistic draft edits.

The project-resource and collection HTTP surfaces now delegate to the common
artifact identities and sealed versions while retaining their historical response
envelopes for package clients. New writes no longer create `ProjectResource` or
`CollectionRevision` rows. The BIM registered-resource registry was removed in F0a:
an Instance resolves only package files and organization library versions.
Portable imports use the library closure as the source of truth as well: the
legacy `resources` and `collections` arrays are checked as indexes and never
materialized into the retired tables.
Open items are limited to migrating old stored rows, extending exact editor
discovery, recursively closing foreign portable dependencies, and broadening
seed/E2E coverage. They do not affect the immutability or reproducibility
guarantees of newly-created library versions.


## Scientific definition content

Library studies use `apiVersion: "openbinding/study/v1"`, `cases` containing
`{caseRevisionId, compositionDigest}`, exact `engines` (including `mode`),
`parameter_sets` and `seeds`. Sealing checks the existing study matrix bounds,
engine options, executable case snapshots, case composition hashes and organization
ownership. Case revisions from different projects in that organization are allowed.

Library collections use `apiVersion: "openbinding/collection/v1"` and an ordered
`members` array of exact artifact references or `{caseRevisionId, compositionDigest}`.
Artifact members must also appear in the version's fixed `dependencies`; duplicate
members are rejected. Case members have immutable FK rows in
`artifact_case_references`, introduced by migration `c4d5e6f7a8b9`.

Study creation accepts `definition.collection_version_id`, an accessible sealed
library Collection version. It expands its exact case members, including cases in
other projects of the same organization, and stores the portable `collection`
reference in the sealed study content and dependency graph. Additional explicitly
selected cases are allowed. A later collection version never changes an existing
study. The old `collection_revision_id` creation parameter has been removed.
The frontend study builder uses the common version picker for this selection.

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

Migration `d5e6f7a8b9c0` removes the duplicated `studies.definition` column and adds
version FKs to studies and runs. Run identity, definition and matrix hashes cannot
be updated in SQL; run deletion is rejected. Studies with runs can be archived
using `PATCH {"archived": true}` and restored, preserving history. Lists omit
archived studies unless `include_archived=true`; archival prevents new runs.
The frontend exposes shared-version selection, adoption and archive/restore.
Migration `e6f7a8b9c0d1` also protects cell identity, case revision, Engine reference,
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
creates or reads them; their tables stay until the F0b baseline). A study is exported instead (the CSV of the
Results tab). Sealed versions no longer carry evidence (`manifest.evidence` is always empty), and package export and
import no longer carry reports, publications or job evidence.

Migration `f7a8b9c0d1e2` performed the report cutover and added evidence retention. A fresh
SQLite upgrade and the complete PostgreSQL chain have passed. The complete development
seed requires a PostgreSQL volume created after this cutover; when an older volume
is present, follow the targeted reset procedure in the README before starting the
stack.

Import checks identity collisions and retains source UUIDs when absent.
