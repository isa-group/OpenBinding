# PR previews: operator runbook

**Status: PLAN for the operator commands.** The commands below are the ones change `m05-pr-previews` specifies
(`openspec/changes/m05-pr-previews/`). `labctl preview` is factory-side and not built.

- In the repository already: the planner `lab/previews/previews.py` with its tests (`lab/tests/test_previews.py`),
  and the live isolation probe `lab/tests/test_preview_isolation.py`.
- Also in the repository: the lab Compose files are parameterised by `DEMO_LAB_PORT` (default 18100).
- Still pending: the factory validator `lab_compose` accepting the parameterised file (F1) and `labctl preview` (F2).

Until `labctl preview` lands, the only lab stack is the develop lab on `127.0.0.1:18100` (`docs/DEMO.md`).

## What a preview is

- One Compose project `openbinding-pr-<number>` per PR, built from the tracked lab Compose file at the PR head. It
  has its own network and its own volumes (`openbinding-pr-<number>_lab-pg-3`, …).
- Only open PRs whose head branch is in this repository get one. Closed, merged and fork PRs are refused.
- One port of `127.0.0.1` in 18101–18199. 18100 is always the develop lab. A preview keeps its port until it is
  destroyed, also while stopped, unless its start fails on a port collision, which releases the port.
- Synthetic data only: the `seed_lab.py` users of `docs/DEMO.md`, SPACE disabled, and synthetic secrets
  (`DEMO_PG_PASSWORD`, `DEMO_JWT_SECRET`, `DEMO_FERNET_KEY`, `DEMO_BIM_TOKEN`, `DEMO_SEED_PASSWORD`) generated when
  the preview is first started and kept unchanged until it is destroyed.
- Started only on request. It expires after 7 days (168 h) with no recorded activity. Activity means a request or
  start, a refresh, an `open`, or a G12 or screenshot run by the factory. Health checks, `list` and refused runs are
  not activity.
- G12 and screenshots run only on a preview of the PR's current head. After a push, refresh the preview first.
- PR heads that branched before the Compose parameterisation landed cannot be previewed until they are rebased onto
  `develop`.
- With the develop lab running, at most one PR preview runs at a time (9216 MiB lab memory cap).

## Operations

| Task | Command | Result |
|---|---|---|
| Request | `labctl preview request <pr>` | allocates a port, builds the PR head, seeds, `ready`; on a different head, refreshes in place; on the same running head, only records activity; refused with `preview_pr_not_eligible`, `preview_untracked_compose`, `preview_ports_exhausted` or `preview_capacity_reached` |
| List | `labctl preview list` | PR, head SHA, port, status, `last_active_at`, expiry time; orphan projects flagged |
| Open | `labctl preview open <pr>` | starts a stopped preview (subject to the cap), records the access and prints the tunnel command |
| Refresh | `labctl preview refresh <pr>` | rebuilds at the current PR head on the same port, volumes and secrets, then re-runs the seed; a stopped preview is subject to the cap |
| Stop | `labctl preview stop <pr>` | `down` without `-v`: removes the containers, frees memory, deletes no volume or image, keeps the port |
| Expire | `labctl preview expire [--dry-run]` | the hourly sweep: every preview idle for ≥ 168 h goes to `labctl destroy` |
| Destroy | `labctl destroy preview <pr>` | the only deletion: containers, volumes, the images this preview owns (never an image another preview or the develop lab uses, and never with force), its secrets and work tree; the port is released |

Never remove preview volumes or images with `docker` or `docker compose` directly. Deletion goes only through
`labctl destroy` (constitution 18.3).

## Opening a preview from the Mac

`labctl preview open <pr>` prints the command, for example for port 18101:

```sh
ssh -L 18101:127.0.0.1:18101 <host-lab>
```

Then open <http://localhost:18101>. The API is at <http://localhost:18101/api/health/ready>. Sign in with the
synthetic users of `docs/DEMO.md`. Each preview has its own seed password, kept in the factory's private store: ask
the operator, who reads it there for you. It is never written in the repository or in the preview's record. Previews
have no public hostname: the homelab Caddy serves only the develop preview.

## Isolation check

`lab/tests/test_preview_isolation.py` checks, from preview A, that B's port is refused and that A reaches its own
`web` (one direction; swap A and B and run again for the other). Until `labctl preview` lands, only two stand-in projects can run it: each needs a `gateway` service with `python` on PATH, a
`web` service whose container port 8080 is published on `127.0.0.1:<port>`, and the default network
`<project>_default`, both up and healthy. It runs only with `OPENBINDING_LAB_PROBE=1` and needs `OPENBINDING_PROBE_PROJECT_A` and
`OPENBINDING_PROBE_PROJECT_B` (projects `openbinding-pr-<n>`) with `OPENBINDING_PROBE_PORT_A` and
`OPENBINDING_PROBE_PORT_B` (18101–18199). With the variable set, a missing lab fails instead of skipping. The command
and the preconditions are in `docs/DEMO.md`, section `PR previews`.

## When something fails

- `failed` after a request or refresh: `lab_compose logs` on the project. Retry with `refresh` (subject to the cap,
  and on a new port if the old one was lost to a collision), or refresh to the previous head. A failed build during a
  refresh leaves the old head running.
- A schema that no longer migrates: `labctl destroy preview <pr>`, then `request` again. The data is synthetic, and
  the new preview gets new secrets.
- `preview_pr_not_eligible`: the PR is closed or merged, or its head branch is in a fork. Push the branch to this
  repository and open the PR from it.
- `preview_capacity_reached`: stop a preview whose G12 is done, or wait.
- `preview_ports_exhausted`: no port in 18101–18199 is free. Destroy one of the least recently active previews that
  `list` shows.
- `preview_untracked_compose`: the Compose file is not tracked at the PR head. Commit it to the PR branch.
- `preview_head_stale`: the preview runs a different head than the PR's current one. Run
  `labctl preview refresh <pr>`, then G12 or the screenshot again.
