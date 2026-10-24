# PR previews: operator runbook

**Status: PLAN, not implemented.** The commands below are the ones change `m05-pr-previews` specifies
(`openspec/changes/m05-pr-previews/`). They do not exist until the factory's `labctl preview` and the repository's
Compose parameterisation have landed. Until then, the only lab stack is the develop lab on `127.0.0.1:18100`
(`docs/DEMO.md`).

## What a preview is

- One Compose project `openbinding-pr-<number>` per PR, built from the tracked lab Compose file at the PR head. It
  has its own network and its own volumes (`openbinding-pr-<number>_lab-pg-3`, …).
- One port of `127.0.0.1` in 18101–18199. 18100 is always the develop lab.
- Synthetic data only: the `seed_lab.py` users of `docs/DEMO.md`, fresh synthetic secrets, SPACE disabled.
- Started only on request. It expires after 7 days (168 h) with no recorded activity. Activity means a request, a
  refresh, an `open`, or a G12 or screenshot run by the factory. Health checks and `list` are not activity.
- PR heads that branched before the Compose parameterisation landed cannot be previewed until they are rebased onto
  `develop`.
- With the develop lab running, at most one PR preview runs at a time (9216 MiB lab memory cap).

## Operations

| Task | Command | Result |
|---|---|---|
| Request | `labctl preview request <pr>` | allocates a port, builds the PR head, seeds, `ready`; on a newer head, refreshes in place; refused with `preview_capacity_reached`, `preview_ports_exhausted` or `preview_untracked_compose` |
| List | `labctl preview list` | PR, head SHA, port, status, `last_active_at`, expiry time; orphan projects flagged |
| Open | `labctl preview open <pr>` | starts a stopped preview (subject to the cap), records the access and prints the tunnel command |
| Refresh | `labctl preview refresh <pr>` | rebuilds at the current PR head on the same port and volumes, then re-runs the seed |
| Stop | `labctl preview stop <pr>` | `down` without `-v`: removes the containers, frees memory, deletes no volume or image, keeps the port |
| Expire | `labctl preview expire [--dry-run]` | the hourly sweep: every preview idle for ≥ 168 h goes to `labctl destroy` |
| Destroy | `labctl destroy preview <pr>` | the only deletion: containers, volumes, project images and work tree; the port is released |

Never remove preview volumes or images with `docker` or `docker compose` directly. Deletion goes only through
`labctl destroy` (constitution 18.3).

## Opening a preview from the Mac

`labctl preview open <pr>` prints the command, for example for port 18101:

```sh
ssh -L 18101:127.0.0.1:18101 <host-lab>
```

Then open <http://localhost:18101>. The API is at <http://localhost:18101/api/health/ready>. Sign in with the
synthetic users of `docs/DEMO.md`. The seed password of each preview is in the factory's private store. Previews
have no public hostname: the homelab Caddy serves only the develop preview.

## When something fails

- `failed` after a request or refresh: `lab_compose logs` on the project. Retry with `refresh`, or refresh to the
  previous head.
- A schema that no longer migrates: `labctl destroy preview <pr>`, then `request` again. The data is synthetic.
- `preview_capacity_reached`: stop a preview whose G12 is done, or wait.
- `preview_ports_exhausted`: destroy one of the least recently active previews that `list` shows.
- `preview_untracked_compose`: the Compose file is not tracked at the PR head. Commit it, or use the lab profile
  that `develop` uses.
