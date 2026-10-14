# Reset of the `openbinding` PostgreSQL role password (laboratory)

Recovery of a lost synthetic credential. The data in the `lab-pg-3` volume is kept: no volume is deleted or
created, and only the password of the role `openbinding` changes.

## Cause

**Historical cause; the behaviour described in this paragraph has been superseded.** At the time, `lab_compose` stored the
environment it received with `up`, and when a later `up` was given an `environment`, that stored set was **overwritten**, not
merged. A value passed alone, or a partial set, replaced everything stored, and the variables left out (the `DEMO_*` secrets
among them) were gone. So `environment` had to carry the **complete** set of variables of the laboratory, or be omitted
altogether. The password was lost that way, and the role keeps the old one in `lab-pg-3` while the manifests are now given a
different `DEMO_PG_PASSWORD`.

**Current behaviour of the tool:** the `environment` of `lab_compose` is a PATCH (merge) over the stored variables: omitted or
`{}` keeps all of them, only the keys sent explicitly are replaced, and `validate` uses the same semantics. A partial set no
longer drops the other variables, so the incident above should not repeat. This reset is still the way to put a new password
into the role. Sending the complete set, as the procedure below says, remains valid; whether the merge covers every case was
not re-verified by this document.

## What `compose.lab-pgreset.json` does

One service, `postgres`, in the same project (`openbinding-lab`) as `compose.lab.json`, with the same image
(`postgres:16-alpine`), user (`70:70`), volume (`lab-pg-3` on `/var/lib/postgresql/data`), `PGDATA`
(`/var/lib/postgresql/data/pgdata`) and `mem_limit` (384m); `restart` is `no`. It runs a script, once:

1. `pg_ctl -D "$PGDATA" -o "-c listen_addresses=''" -w start`: a temporary server with no TCP listener, only the
   local unix socket (the `initdb` of the official image leaves local connections as `trust`).
2. `ALTER ROLE openbinding PASSWORD :'pw';` through `psql -v pw="$DEMO_PG_PASSWORD"`, so psql quotes the value; the
   SQL text and the compose command line carry no password.
3. `pg_ctl -D "$PGDATA" -m fast -w stop`, whether or not step 2 succeeded.
4. Prints `pg-role-password-reset-ok` and exits 0. Any failure (empty password, server not starting, psql error)
   exits non-zero and prints no such line.

`DEMO_PG_PASSWORD` enters only as the pure reference `${DEMO_PG_PASSWORD}` in `environment`; in the command it is
`$$DEMO_PG_PASSWORD`, the compose escape for a `$` that the container's shell expands, so `docker inspect` shows
the reference-free command. Within the container the value is an argument of the short-lived `psql` process; there is no
network and no other user. The memory sum of 4032 MiB (`docs/DEMO.md`) is that of the whole laboratory and does not
apply to this recovery-only manifest.

## Procedure

Have the **complete** environment at hand (a precaution that is no longer required by the tool, see "Cause"): every variable
that `compose.lab.json` references, with the `DEMO_PG_PASSWORD` that must become the role's password. Use the same set in both
`up` calls.

1. `lab_compose down` (the volumes stay).
2. `lab_compose up file=compose.lab-pgreset.json` with the complete `environment`.
3. Wait for the service to exit and read its output: it must be exactly `pg-role-password-reset-ok`, exit code 0.
4. `lab_compose down`.
5. `lab_compose up file=compose.lab.json` with the **same complete** `environment`.

## Verification

- Step 3 shows `pg-role-password-reset-ok` and exit code 0 (the container is `Exited (0)`).
- After step 5, `postgres` reaches `healthy` and so do `gateway` and `worker`: they connect with
  `postgresql+asyncpg://openbinding:${DEMO_PG_PASSWORD}@postgres:5432/openbinding`, so a healthy
  `/health/ready` means the new password works.
- The seeded synthetic data is still there (for instance, the seeded users can still sign in). If the volume had
  been recreated the database would be empty.

## The password is never printed

The script does not echo the value, does not use `set -x`, and discards the output of `pg_ctl` and `psql`.
Do not paste the value into a ticket, a log or a command line; it reaches the manifests only as `${DEMO_PG_PASSWORD}`.
`lab/tests/test_lab_pgreset.py` checks the manifest statically for all of this.
