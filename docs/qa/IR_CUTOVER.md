# IR cut-over: snapshots compiled by bim-toolchain 0.1.x

Decision (2026-10-14): the IR is the normalized one of `bim-toolchain` 0.2.0. There is no compatibility with the IR of
0.1.x, no second implementation of the old order and no migration of installations that do not exist. This document is the
procedure to bring a database that holds 0.1.x snapshots (the lab) to 0.2.0, and what the gateway promises meanwhile.
It does not touch `bim-toolchain`.

## What was measured

After deploying `bim-toolchain` 0.2.0 in the lab (measured on `bef53047`), the job launches of `tools/smoke_lab.py`
(`owner_job`, `idempotency`, `concurrency_limit`) and one Playwright test (launching a job) answered
`422 contract_not_installed`. Users, organizations, projects and cases were fine.

## Cause

`BindingProblem.from_document(verify=True)` requires the Profile and Dialects an IR pins to be exactly the installed ones
(`bim-toolchain/docs/DIGESTS.md`). Their descriptors carry the `compilerDigest`, which changed with 0.2.0. The lab's
seeded snapshot (`lab-owner`, case `simple-seq`) was compiled by 0.1.0, so every operation on its stored IR is refused.

What the gateway stores per snapshot (`InstanceSnapshot`, `BindingIRSnapshot`, `InstanceResource`):

| Data | Depends on the toolchain? |
| --- | --- |
| `source_archive` (the package), `root_document`, `instance_digest`, `package_digest`, `resource_digests` | no (`packageDigest`, `instanceDigest` did not move, `DIGESTS.md`) |
| `v1_instance_resources` (contents, `dialect_id` = `name/vN`) | no |
| `v1_binding_ir` (`document`, `ir_digest`, `source_map`) | yes |
| `v1_instance_snapshots.compilation_digest` | yes (it contains the `compilerDigest`) |

Two facts decide the solution:

- The package is stored, so the derived data can be compiled again; no stored IR needs a migration function.
- `binding_case_revisions` are sealed by database triggers (`sealed artifact data is immutable`: any `UPDATE` or `DELETE` is
  rejected, in SQLite and PostgreSQL), and `case_composition_digest` (`packageDigest`, `resourceDigests`, resources) does
  not contain the compilation. A new revision of the same case would have the same digest and be refused by
  `uq_binding_case_digest`. So a revision cannot be pointed at another snapshot: the snapshot it pins is regenerated
  in place.

There was no route that recompiled a snapshot. This change adds none (no new API surface, no OpenAPI change).

## What the gateway does now

- **Stable refusal.** `services.snapshots.snapshot_ir` (the way `POST /v1/jobs` and study cells read a snapshot) and
  `GET /v1/jobs/{id}/analysis/neighborhood` check `integrations.bim.ir_is_installed(ir)` before using a stored IR. A
  stale one answers `422` with code `contract_not_installed` and the fixed message `bim.STALE_IR_MESSAGE` ("This snapshot
  was compiled by another bim-toolchain release than the installed one and must be recompiled ... "). The message contains
  no stored value (no id, digest or version) and no job is written. It is the code that the toolchain itself uses and that
  the frontend already maps (`caseErrors.ts`), so there is no new code and `docs/openapi.json` does not change
  (`tools/dump_openapi.py --check` passes). *Amended afterwards:* when the stored package is itself what the installed
  toolchain refuses (invalid, unreadable, or read as another package), the launch answers `422 snapshot_not_recompilable`
  with the reason instead, since "recompile" would send the user nowhere; this adds a code that `caseErrors.ts` does not map
  yet, and `tools/dump_openapi.py --check` was not re-run for it.
- Any other path that hands a stored IR to the toolchain gets its `ContractError`, which the central handler
  (`main.bim_error`) answers as `422` with the toolchain's code: never a 500.
- **Explicit recompilation.** `services.snapshots.recompile_stale_snapshots(session)`: for every snapshot that a case
  revision pins and whose IR is not the installed toolchain's, it compiles `source_archive` again for the same owner and
  replaces the snapshot's `v1_binding_ir` row and its `compilation_digest`. It does not commit.
  - It requires the new compilation to have the same `packageDigest` and `instanceDigest`; otherwise the snapshot is left
    as it was (`snapshot_identity_changed`).
  - If a snapshot of the same owner and package already exists for the installed toolchain (a "copy": an upload, or a seed run
    after the release, made it) it holds the identity the regenerated snapshot needs. The copy is removed if no revision and no job
    points at it; otherwise the snapshot is left as it was (`snapshot_conflict`).
  - A package that cannot be compiled again is left as it was and reported with the toolchain's error code and its findings
    (`RecompileReport.failures[].refusal`: code, pointers, redacted messages; `seed_lab.py` prints them as
    `recompileFailed[].reason`). It is kept, not deleted or hidden: its launches answer `422 snapshot_not_recompilable`
    instead of `contract_not_installed`, because recompiling cannot help it (see
    [SNAPSHOT_INVALID_INSTANCE.md](SNAPSHOT_INVALID_INSTANCE.md), which also has the read-only `tools/diagnose_snapshots.py`).
  - A second call finds nothing to do.
- `tools/seed_lab.py` calls it first, then does what it always did. Importing it still has no side effects.

## What is regenerated, kept and purged

| | |
| --- | --- |
| Regenerated (in place, same row ids) | `v1_binding_ir.document`, `ir_digest`, `source_map`; `v1_instance_snapshots.compilation_digest`, of the snapshots that a case revision pins |
| Removed | only the "copy" described above, with its `v1_instance_resources` and `v1_binding_ir` rows, when nothing points at it |
| Kept | users, API keys, organizations, memberships, projects, cases, case revisions and their artifacts, the library (artifacts and versions), snapshots (ids, package, instance, resources), volumes |
| Jobs and results | kept untouched. A job keeps the IR it ran with (`original_request.bindingProblem`, `provenance.irDigest`) as history; asking the toolchain to analyse it again answers the stable 422. Evidence-protected jobs are never written |
| Snapshots no revision pins (uploads) | not touched; uploading the package again makes a snapshot of the installed toolchain |
| Purged | nothing. There is no migration and no `DELETE` of IR-derived tables |

Why no purge, unlike the precedent `alembic/versions/9f1c2d3e4a5b_bim_v1_resources.py` (BIM v1 cut-over: purging rows
from `jobs` and `federated_engines`): that cut-over removed a language, so its payloads could not be replayed. Here every
stale snapshot has its package and can be compiled again, and a migration cannot know which toolchain is installed.
A purge would destroy recoverable data and, for jobs that are evidence of a published artifact, the triggers would refuse it.

## Procedure for the lab

Commands are those of `docs/DEMO.md` ("Exact sequence with `lab_compose`"). `DEMO_SEED_PASSWORD` is the lab's, injected by
whoever runs it.

1. Deploy the checkout with `bim-toolchain` 0.2.0: `down` if the SHA changed, then `up` with `DEMO_E2E=0`.
2. Recompile and seed (`seed` service):

   ```sh
   DEMO_SEED_TOOL=seed_lab.py DEMO_SEED_ARGS=--verbose docker compose run --rm --no-deps seed
   ```

   On a lab that holds 0.1.0 snapshots the JSON report has, in `created`, one `recompiled-case-revision:<uuid>` per revision
   whose snapshot was regenerated, `recompileFailed: []`, and the same `counts` and `ids` as before. A line on stderr
   (`snapshot <id> could not be compiled again (<code>)`) and `recompileFailed` (with the compiler's findings under `reason`)
   list what could not be: the launch of those still answers a stable 422 (`contract_not_installed`, or
   `snapshot_not_recompilable` when the package itself is what is refused). `tools/diagnose_snapshots.py` reads why, without
   writing ([SNAPSHOT_INVALID_INSTANCE.md](SNAPSHOT_INVALID_INSTANCE.md)).
3. Run it again: `created: []`.
4. `DEMO_SEED_TOOL=smoke_lab.py DEMO_SEED_ARGS='--with-space' docker compose run --rm --no-deps seed` (drop `--with-space`
   as in `DEMO.md`): `owner_job`, `idempotency` and `concurrency_limit` launch from the seeded snapshot.
5. `up` with `DEMO_E2E=1` for the Playwright specs.

If the seed was already run after the deployment (the sequence runs it on every `up`), the old seed compiled a second snapshot
of the package for `lab-owner`; step 2 removes it (`snapshot_conflict` only if a job already uses it).

Order matters only for tidiness: the seed recompiles before it compiles the case, so it does not make a copy it would remove.

## Rollback

Going back to the 0.1.x toolchain is not supported by this tree: there is no code for the old order and no flag. The way back
is the baseline: `git revert` of the 0.2.0 commits of `bim-toolchain` and of this change (or a deployment of the previous
SHA), then `seed_lab.py` again. The same mechanism works in that direction (a snapshot whose IR is not the installed
toolchain's is compiled again), but the IR 0.2.0 stored is replaced and the 0.1.0 one is not kept: no data is lost, because
the package is the source, and the order of the sets of the IR goes back to that of 0.1.x as the compiler of the reverted tree
produces it. Jobs are history and are not touched either way.

## Tests

`openbinding-gateway/tests/test_ir_cutover.py` (SQLite, synthetic; an "old" snapshot is made by changing the pinned
descriptors and the compilation digest of a real one, as 0.1.0 would have stored them):

- `ir_is_installed` (profile, dialect, no `spec`);
- a launch on a stale snapshot through `JobSubmission`: `422 contract_not_installed`, the fixed message, no stored value, no job;
- over HTTP: `POST /v1/jobs` and the neighborhood of an old job answer 422, the job and its report stay readable;
- recompilation: same ids, same digests, the revision still pins the snapshot, a launch on it creates a job, a repeated upload
  is the same snapshot, a second call changes nothing, an unpinned snapshot is left alone;
- the copy: removed when unused, kept (and `snapshot_conflict`) when a job uses it; a corrupt package and a package read as
  another one are reported and left alone;
- the seed: a lab of another toolchain is regenerated with the same ids and counts, users, keys and password hashes untouched,
  the second run changes nothing; the copy an earlier seed made is removed; a current lab is unchanged.

`recompile_stale_snapshots` writes only tables without the sealing triggers (`v1_binding_ir`, `v1_instance_snapshots`) and
deletes only copies. At first no PostgreSQL test was added for it (there is no migration). The removal of the copy, the
isolation between owners, the rollback and the race of two replicas now have PostgreSQL tests in
`tests/test_duplicate_copy_purge_pg.py` ([PG_REAL_RUN.md](PG_REAL_RUN.md)); they have **not been run on a PostgreSQL**:
the worktree that wrote them has none, so they skip there. A snapshot whose package the compiler refuses is covered by
`tests/test_snapshot_invalid_instance.py`; the service's own contract (report, isolation, no commit) is
`tests/test_snapshot_recompile.py`. Note for SQLite: it releases a savepoint outside `BEGIN` as a commit, so a rollback after
`recompile_stale_snapshots` does not undo it there; the rollback is shown on PostgreSQL only.

## Not verified

- The lab itself: nothing here was run against the deployed lab, so the smoke (9 steps) and the Playwright specs after the
  procedure are not measured. The cause was established from the code and the measured symptom.
- PostgreSQL: the `DELETE` of a copy and the update of `compilation_digest` ran in SQLite only in the registered runs. The unique
  key `(owner_id, package_digest, compilation_digest)` is the same in both, and the order (delete, flush, update) respects it;
  `tests/test_duplicate_copy_purge_pg.py` is written to confirm it on a real server and has not run yet.
- The snapshot that failed with `invalid_instance` in the lab at `c2d46151`: its cause is unknown
  ([SNAPSHOT_INVALID_INSTANCE.md](SNAPSHOT_INVALID_INSTANCE.md) has the tool and the decision branches).
- A snapshot compiled with registered resources (`namespace/name/version`) is compiled again with the resources published
  now; if they are gone it is reported, not regenerated.
- Environments other than the lab: `seed_lab.py` refuses `APP_ENV=prod` and no production installation holds 0.1.x
  snapshots (decision above). There is no command to recompile outside the seed.
