# The snapshot that could not be recompiled (`invalid_instance`)

At `c2d46151` the lab seed reported, in `recompileFailed`, one old synthetic snapshot that
`recompile_stale_snapshots` (`services/snapshots.py`, [IR_CUTOVER.md](IR_CUTOVER.md)) could not compile again with the
installed `bim-toolchain` 0.2.0: code `invalid_instance` ([JOINT_STATUS.md](JOINT_STATUS.md), [DEMO.md](../DEMO.md)). The
seed left it as it was, as designed, and printed only the code.

## Result of the real diagnosis (head `ea955411`, 2026-10-14)

Reported by the controller; this document did not re-run it. `tools/diagnose_snapshots.py` was run in the lab, read only. **The
cause is now known** (the sentence "the reason is not known" of the first version of this document is **superseded**).

| | |
|---|---|
| Snapshot | `648a0d79-2fb4-4b7a-bf62-e02106ca0c53`, name `demo_01_simple_seq`, owner `lab-owner`, created 2026-10-13, 2777 B |
| `packageDigest` | `sha256-0b4eb998...c12a4` (abbreviated as reported) |
| Pinned by | revision 1 of the case `simple-seq` of `lab-main/bim-demo` |
| Jobs using it | 30 |
| Report | `compilerError` code `invalid_instance`, diagnostic `contract_not_installed` at `/spec/contracts` of `instance.json`: "An exact pinned contract is not installed" |

**Cause.** The 0.1.x package pins an exact version of a contract (profile / dialect) that toolchain 0.2.0 no longer installs.
The package is really invalid for 0.2.0. It is **not** a recompilation bug and **not** a loss of information: the package has no
registered resources (`registeredResources` empty). Its compilation cannot be repaired in place.

**What was done (the first branch of "Decision branches" below).** Nothing was deleted or rewritten. The snapshot, its package,
its IR, revision 1 and its 30 jobs are kept as evidence. Launching it answers `422 snapshot_not_recompilable` with a `reason`;
the API says so and the UI maps the code (`frontend/src/pages/Cases/caseErrors.ts`). Revision 2 of the case (new seed, another
snapshot) does run.

**Residual risk, not decided.** The same diagnosis listed two more stale snapshots, of other owners (`lab-member`, prefix
`4d76d948...`; `lab-viewer`, prefix `4b8eaec4...`), with status `blocked` and code `snapshot_conflict`. Their package does compile
with 0.2.0, but a copy of the same package, used by 4 jobs, holds the identity (owner, package, `compilation_digest`) and cannot
be deleted. No case revision pins them. They remain stale: launching them answers the `recompile` 422 although the recompilation
is blocked. It was **not decided** to delete anything.

The sections that follow were written before the diagnosis; where they say the cause is unknown or the frontend has no entry,
that is superseded by this section.

*Original text (historical):* the reason was not known; nobody had read the stored package or the compiler's findings. The rest
of this document covers what was built so that the controller could read it, and what happens to the snapshot whichever way it
turns out.

Nothing here deletes, hides or rewrites a snapshot, its package, its IR or the case revision that pins it. "Repaired" is never
"deleted": a corrected package is a new snapshot and the old one stays as evidence.

## What exists now

| | |
| --- | --- |
| `openbinding-gateway/tools/diagnose_snapshots.py` | Read-only report, one JSON document. Uses only the existing `Settings` (`DATABASE_URL`, `BIM_MODE` and the rest). Never commits (it ends with a rollback, and on PostgreSQL opens the transaction `READ ONLY`). |
| `services.snapshots.diagnose_snapshot` / `compile_refusal` | The same logic, importable: compile the stored package with the installed toolchain and describe the refusal in stable, redacted terms. Writes nothing. |
| `RecompileReport.failures` | `recompile_stale_snapshots` now keeps the compiler's findings with each failure (`failed` still gives `(id, code)` pairs). `seed_lab.py` prints them as `recompileFailed[].reason`. |
| `422 snapshot_not_recompilable` | What launching (`POST /v1/jobs`, study cells) a stale snapshot answers when its package is what the installed compiler refuses. |

### What the report says per snapshot

By default it lists the *stale* snapshots (the stored IR is not the installed toolchain's) whose status is not `recompilable`.
`--snapshot ID` (repeatable) examines and lists exactly those; `--all` lists every snapshot.

```text
snapshotId, ownerId, name, createdAt
packageDigest, instanceDigest, storedCompilationDigest, storedIrDigest, archiveBytes, archiveDigest
pinnedBy[]: organizationId/Slug, projectId/Slug, caseId/Slug, revisionId, revision, revisionDigest
jobsUsingIt
status, code
storedIrIsInstalledToolchain
compilesWithInstalledToolchain       true | false | null (the toolchain did not answer)
stillTheSamePackage                  true | false | null: the compiled package/instance digests equal the stored ones
currentPackageDigest, currentInstanceDigest
registeredResources[]                namespace/name/version of the registry resources the package pins
compilerError: {verdict, code, message, diagnostics[{code, resource, pointer, irPath, bpmnElement, message}], diagnosticCount}
```

and at the top `toolchain` (`mode`, `compilerDigest`, or the error class if it did not answer), `examined`, `listed`,
`byStatus`, `notFound`. The credentials of the configuration (and the password of the database URL) are removed from the
output; the compiler's text is kept exactly (messages are cut at 300 characters, at most 5 diagnostics, with their count) after
credential-shaped strings are removed. No archive bytes, no IR, no resource content are printed.

`status`:

| status | Meaning | Marked not runnable? |
| --- | --- | --- |
| `current` | its IR is the installed toolchain's | no |
| `recompilable` | the stored package compiles, reads as the same package, and nothing blocks it | no (`contract_not_installed` until recompiled) |
| `blocked` (`snapshot_conflict`) | would recompile, but a copy that a revision or a job uses holds its identity | no |
| `not_recompilable` | the compiler refuses the package (`invalid_instance`), cannot read it (`unreadable_package`, e.g. `package_error`), refuses it otherwise, reads it as another package (`snapshot_identity_changed`) or does not produce an IR of the installed toolchain (`recompile_unchanged`) | **yes** |
| `undetermined` | the toolchain or the database did not answer (503/5xx, `database_error`) or something unexpected happened: no verdict about the package | no (it is never called refused without an answer) |
| `ir_missing` | no IR row | no |

## The honest mark

The mark is **derived, not stored**: whenever a stale snapshot is launched, `snapshot_ir` compiles its stored package (the path
is already an error path) and, if the package is what is refused, answers

```json
HTTP 422
{"code": "snapshot_not_recompilable",
 "detail": "This snapshot was compiled by another bim-toolchain release, and the installed one does not accept its stored package, so it cannot be recompiled or run. The package and the case revisions that pin it are kept unchanged as evidence; correct the source and upload it again to get a snapshot that can run.",
 "reason": {"code": "invalid_instance", "message": "...", "diagnostics": [{"code": "...", "pointer": "...", "message": "..."}], "diagnosticCount": 1}}
```

instead of `contract_not_installed` ("must be recompiled ..."), which would send the user to a recompilation that cannot work. No
job is written. A derived mark cannot go stale (if the toolchain or the package changes, the answer follows) and needs no
migration; the cost is one compilation per launch attempt of such a snapshot, never on the happy path. If a stored state is
wanted later (for a listing in the UI, say) it needs a column on `v1_instance_snapshots`, a migration, and a decision on who
writes it: out of scope here, and not needed for the behaviour above.

**Frontend:** `frontend/src/pages/Cases/caseErrors.ts` maps `contract_not_installed` among the dialect codes and, now, also
`snapshot_not_recompilable` (verified by reading the file). (The first version of this document said it had no entry yet:
superseded.)

## Running the tool in the lab

The tool travels in the gateway image (`tools/` is copied into it), so it must be rebuilt by `up` before `seed` can run it, and
`seed` runs with the environment saved by the last `up` ([DEMO.md](../DEMO.md), "Exact sequence with `lab_compose`").

1. `lab_compose up` with the checkout (as in DEMO.md), `DEMO_E2E=0`, `DEMO_SEED_TOOL=diagnose_snapshots.py`,
   `DEMO_SEED_ARGS=` (empty: the default listing), and the same `DEMO_SEED_PASSWORD` as the lab (the tool does not read it; the
   variable is kept so that the saved environment is the lab's).
2. `lab_compose seed`. Equivalent to
   `DEMO_SEED_TOOL=diagnose_snapshots.py DEMO_SEED_ARGS= docker compose run --rm --no-deps seed`. Read stdout: one JSON document.
   Exit code 0 means the report was produced, whatever it found; 2 is a bad argument or no `DATABASE_URL`; 5 an unexpected
   failure (one redacted line on stderr).
3. For a given snapshot (the id is in `recompileFailed` of the seed): `DEMO_SEED_ARGS='--snapshot <uuid>'`; for everything:
   `DEMO_SEED_ARGS='--all'`.
4. Put `DEMO_SEED_TOOL` back to `seed_lab.py` with another `up` before the next normal seed.

The toolchain it compiles with is the one the seed container is configured for (`BIM_MODE`, `BIM_SERVICE_URL`, ...), the same one
`seed_lab.py` used when the snapshot failed. If it cannot answer, the report says so (`toolchain.error`, status `undetermined`)
and no snapshot is blamed.

## Decision branches

**Branch chosen (real report read at `ea955411`): the first row.** `status: not_recompilable`, `registeredResources: []`, and the
diagnostic `contract_not_installed` points into the package (`/spec/contracts` of `instance.json`): the package is really
invalid for the installed compiler (the pinned contract version is not installed in 0.2.0). Nothing is repaired in place; the
snapshot, package and revision stay; launching answers `snapshot_not_recompilable` with that reason; revision 2 of the case is the
way forward. The second row (information lost on recompilation) was **discarded** by the report: no registered resources. The
other rows did not apply to this snapshot. For the two `blocked` snapshots of other owners the last row applies ("an operator
decides") and no decision was taken. The table is kept as it was written, as the reference for any other snapshot.

| What the report shows | What it means | What to do |
| --- | --- | --- |
| `status: not_recompilable`, `compilerError.verdict: invalid_package`, diagnostics point into the package (`resource`/`pointer`), `registeredResources: []` | The package is really invalid for the installed compiler (a rule that 0.2.0 enforces and 0.1.x did not). | Nothing is repaired in place. The snapshot, package and revision stay; launching answers `snapshot_not_recompilable` with that reason. If the case is wanted, correct the source and upload it again (new snapshot, new revision). Decide separately whether a stricter rule of 0.2.0 was intended (that is the toolchain's, not this tree's). |
| Same, but `registeredResources` lists resources and the diagnostics talk about an unresolved or unknown resource | The package may be valid and *information was lost when it was rebuilt*: `recompile_stale_snapshots` resolves registered resources again from what is published *now* (`installed_registered_resources`), while the snapshot kept the exact bytes in `v1_instance_resources`. | This is a recompilation bug. Open a follow-up: resolve those resources from the snapshot's own stored rows first, with a regression test (stored resource, published copy removed, recompile still succeeds). Not done here because the cause is not established. |
| `compilesWithInstalledToolchain: true`, `stillTheSamePackage: false` (`snapshot_identity_changed`) | The compiler reads the stored bytes as a different package or Instance: the stored digests and the bytes disagree, or the canonical form changed. | Compare `packageDigest`/`currentPackageDigest` and `instanceDigest`/`currentInstanceDigest`. If the bytes are right, it is a bug of the digest or of the stored value: follow-up with the pair of digests. If the stored digest is wrong, the snapshot is evidence of that and stays. |
| `verdict: unreadable_package` (`package_error`, an invalid ZIP) | The stored archive is corrupt or is not a package. | Kept as evidence; nothing can be recompiled from it. Find how it got there (`archiveBytes`, `archiveDigest`, `createdAt`, `ownerId`) before anything else. |
| `status: undetermined`, `verdict: unavailable` | The toolchain or the database did not answer. | No conclusion: run again when it does (`docker compose logs` of the BIM service). |
| `status: recompilable` | It would recompile now; the seed failed for another reason (a race, a transient error). | Run `seed_lab.py` again; the second run is idempotent. |
| `status: blocked` | A copy of the package that a job or a revision uses holds the identity. | Look at `jobsUsingIt` and `pinnedBy` of the other snapshot; an operator decides. |

The seed's `recompileFailed[].reason` has the same findings for the same snapshot, so a seed run is enough to read the cause once
this tree is deployed; the tool is for reading it again, or for one id, without running the seed.

## Tests

`openbinding-gateway/tools/tests/test_diagnose_snapshots.py` (SQLite, synthetic): the tool lists a refused and a corrupt package
and not a recompilable one; exact findings, ids, organization/project/revision and digests; a stable document from run to run;
`--all`, `--snapshot`, unknown ids; no write statement and no commit while it runs (a counting listener), and the database file
unchanged byte for byte through the real entry point; secrets of the settings removed while the compiler's words are not mangled.

`tests/test_snapshot_invalid_instance.py` and `tests/test_snapshot_recompile.py`: a package the compiler accepts is recompiled; a
package it refuses is reported with its findings and kept byte for byte (snapshot, IR, resources, revision), launching it is
`422 snapshot_not_recompilable` with the reason and no job (service and HTTP); a corrupt package is `unreadable_package`; a
package read as another one and a copy blocked by a job are told apart; an unavailable toolchain is not a verdict and the launch
keeps saying `contract_not_installed`; the correction of the source is a new snapshot and the refused one remains; the refusal text
is bounded and redacted; one failure does not undo another snapshot's recompilation; another owner's snapshot is not the copy.

## Not verified

- **The real snapshot.** (Superseded: the tool was run against the lab's data at `ea955411`, see "Result of the real
  diagnosis"; the cause is `contract_not_installed`.) The tests of this document remain synthetic.
- **PostgreSQL:** the tool's `SET TRANSACTION READ ONLY` and the rollback-only session ran in no automated test (SQLite has no
  such statement; the tool checks the dialect); its only PostgreSQL run is the lab diagnosis above. The `PG_REAL_RUN.md` tests
  cover the recompilation, not the tool.
- **HTTP toolchain mode:** the tests compile in process. With `BIM_MODE=http` the refusal comes through the service's problem
  document; `compile_refusal` handles `BimServiceError` by status, but no test uses a service.
- **Frontend:** the code is mapped in `caseErrors.ts` (see above); the rendering of the message in the browser was not checked
  by this document.
- **Registered resources:** the diagnosis lists them but no test builds a package that pins one.
