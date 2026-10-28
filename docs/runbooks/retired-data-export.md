# Retired data: export before the M9.6 upgrade

Alembic revision `e7f8a9b0c1d2` (M9.6) drops the tables `analysis_tasks` and `sponsor_proposals` and deletes the
draft reports that never produced a sealed version, a publication or a version of their artifact. The owner approved
the drop (own-622ca38adc35425586b2be0f895e9b8d) with one guard: **the revision refuses to run on a database that still
holds those rows until they have been exported** with `tools/export_retired_data.py`. A database where all six
selections are empty (a fresh CI or preview database) needs none of this.

The container entrypoint (`docker-entrypoint.sh`) runs `alembic upgrade head` at every start, and the production
`migrate` service runs it once. So **the export has to happen before the new release starts**, with the entrypoint's
migration switched off.

## What is exported

One JSON Lines file per source, in a new directory, plus `manifest.json` (row count and SHA-256 per file):

| File | Rows |
|---|---|
| `analysis_tasks.jsonl` | every analysis task |
| `sponsor_proposals.jsonl` | every sponsor proposal |
| `report_drafts.jsonl` | `draft` reports with no sealed version, no publication, and an artifact without any version |
| `report_artifact_drafts.jsonl` | their unsealed drafts (payload included), and unsealed `Report` drafts that no remaining report uses |
| `report_artifacts.jsonl` | the `Report` artifacts left with no version, report or draft |
| `report_project_artifacts.jsonl` | the project links of those artifacts |

Kept: publications, every artifact version, studies and runs, project resources, drafts of other kinds, frozen
reports, and draft reports that have a version, a publication or an artifact with a sealed version (their permanent
links keep working).

## Steps

1. **Stop every writer** of the old release: gateway, workers, analysis worker, reconciler. Nothing may create or
   change a row between the export and the upgrade. The guard compares counts, hashes and primary keys, so a row added
   to or removed from a selection is refused; but a selected row whose other columns change after the export keeps its
   key and would pass, with its earlier values in the export. So do not leave writers running.
2. **Run the export from the new image**, against the same database, into a directory **outside the checkout** (it
   holds the only copy of the dropped rows, so keep it out of `git status` and out of anything that is cleaned). The
   directory must exist, be writable by uid 10001 (the image user) and be new or empty. Set
   `OPENBINDING_MIGRATE=skip` so the entrypoint does not run the migration first:

   ```sh
   mkdir -p /srv/openbinding/m96-export && chown 10001 /srv/openbinding/m96-export
   docker compose run --rm --no-deps -e OPENBINDING_MIGRATE=skip \
     -v /srv/openbinding/m96-export:/export gateway \
     python tools/export_retired_data.py --out /export/m96
   ```

   Production (`deploy/compose/production/compose.yaml`): use the `migrate` service, which holds the database secret:

   ```sh
   docker compose -f deploy/compose/production/compose.yaml run --rm --no-deps \
     -e OPENBINDING_MIGRATE=skip -v /srv/openbinding/m96-export:/export migrate \
     python tools/export_retired_data.py --out /export/m96
   ```

   It prints the absolute path of `manifest.json` and exits 0. Exit status 2 means a refusal and nothing was written:
   the output directory is not empty, the database is not at revision `b6c7d8e9f0a1`, or `DATABASE_URL` is missing.
   If the database is already past `b6c7d8e9f0a1`, the data is gone: go to [Recovery](#recovery).
3. **Check the export**: `m96/manifest.json` lists six sources with their `rows`; compare them with what you expect
   (`SELECT count(*) FROM analysis_tasks`, `sponsor_proposals`). Copy the directory somewhere else as well.
4. **Start the new release with the manifest and the mount**. The `gateway` service (and the production `migrate`
   service) need the variable and the same read-only mount:

   ```sh
   OPENBINDING_M96_EXPORT_MANIFEST=/export/m96/manifest.json
   -v /srv/openbinding/m96-export:/export:ro
   ```

   The migration checks that the manifest is in the expected format and head, that every source's `rows` equals the
   rows it would delete now, that every file's SHA-256 matches, and that the primary keys in each file are the primary
   keys of those rows. Any failure raises before any change; the message names the check and the source, the variable
   and the tool, and `alembic upgrade head` exits non-zero, so the container does not start. Fix the cause (usually:
   a writer was still running, so run the export again into a new directory) and start again.
5. **Afterwards** the variable may stay set (the revision runs once) or be removed. Keep the export directory.

## Recovery

- **Upgrade refused**: nothing changed. Read the message, re-export (step 2, a new directory) and retry.
- **Upgrade applied, rows needed again**: `alembic downgrade b6c7d8e9f0a1` recreates `analysis_tasks` and
  `sponsor_proposals` **empty**, with their columns, constraints and indexes (including
  `uq_sponsor_proposal_pending`). It does not restore rows. Restoring from the export is manual: each line of the
  `.jsonl` files is one row as a JSON object keyed by column name (UUIDs hyphenated, timestamps UTC with a `Z`), so a
  short script can insert them back. The deleted report rows must be restored in this order: `report_artifacts`,
  `report_project_artifacts`, `report_artifact_drafts`, `report_drafts`.
- **Disaster**: restore the database from the backup taken before the upgrade (`pg_dump -Fc`, see
  [production.md](production.md)); the export is a convenience copy, not a replacement for the backup.
- **Messages left in Redis** on the `analysis` queue are harmless: no worker reads them any more.
