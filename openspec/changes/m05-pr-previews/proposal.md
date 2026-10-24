# Change: m05-pr-previews

## Why

ROADMAP M0.5: "the factory brings up a preview per PR head on demand and expires it after 7 idle days".
Constitution 19.1 requires every UI or runtime change to pass G12 on a lab preview of its head SHA before it is merged.
Today the lab runs one stack on `127.0.0.1:18100`, so PRs cannot be previewed side by side. INTENT O7 asks for
every UI/runtime change to be previewed, O11 for previews that expire after 7 idle days, and principle 11 for lean
storage. ADR-0019 and ADR-0021 fix the model: Compose projects in the NiPoGi lab, deleted only through `labctl destroy`
(constitution 18.3).

## What Changes

- The lab Compose files publish `web` at `127.0.0.1:${DEMO_LAB_PORT:-18100}`. The local CORS origins and the gateway
  image tag follow the same variable, so the develop lab is unchanged on 18100 when the variable is unset.
- A PR preview is one Compose project `openbinding-pr-<number>`, with its own network and volumes, on one port in
  18101–18199. It is started only on request for an open PR whose head branch is in this repository, built from the
  tracked lab file at the PR head, with synthetic secrets generated at its first start and kept until destroy, and
  the synthetic seed.
- A new request on a different head refreshes the preview in place. G12 and screenshots run only on a preview of the
  PR's current head. 168 idle hours expire it through `labctl destroy`, which removes only the images the preview owns.
- Refusals: `preview_pr_not_eligible` (closed, merged or fork PR), `preview_untracked_compose` (Compose file not
  tracked at the head), `preview_ports_exhausted` (no free port in 18101–18199), `preview_capacity_reached` (above the
  9216 MiB lab memory cap) and `preview_head_stale` (G12 or a screenshot on a preview of an old head).
- `docs/previews/README.md`: an operator runbook, marked as a plan until it is built.

## Impact

- Capability: `lab-deployment`. One MODIFIED requirement (`single-loopback-port` ~1 → ~2) and nine ADDED ones.
- Repository: `compose.lab.json` and the four lab profiles derived from it, `lab/tests/`,
  `openbinding-gateway/tests/test_container_hardening.py`, a new preview planner under `lab/previews/`, and
  `docs/DEMO.md`. The full list is in design.md, "Implementation files".
- Factory (outside this repository): the `lab_compose` validator has to accept the interpolated port and image tag.
  `labctl` needs the `preview` operations, the state record, the eligibility and head checks, the expiry sweep,
  `labctl destroy preview` and the retirement of the unused `openbinding-lab-gateway:latest` image.
- "The preview manager" in the requirements means `labctl preview` applying the rules of the repository planner.
- No HTTP API, OpenAPI or database schema change. No production impact.
- Risk: with the develop lab running, the memory cap allows one running PR preview at a time (design.md §6). SPACE
  stays disabled in previews until the ARCHITECTURE §9.4 `pricing` profile lands: at about 0.7 GiB per stack it would
  put the develop lab plus one preview at about 9464 MiB, above the 9216 MiB cap.
- Order: S1b+S3, then S1a+S2 (merged only after the factory's validator change), then the factory's `labctl preview`,
  then S4 (tasks.md).

## Out of scope

- Public hostnames for PR previews. The homelab Caddy/AdGuard wildcard is excluded. PR previews are reached through
  the SSH tunnel (`ssh -L <port>:127.0.0.1:<port> <host-lab>`) or through the factory: G12 runs inside the
  preview's network, and screenshots come through `lab_screenshot`.
- The develop preview (M0.4) and its Caddy site. Retention of work trees, reports and archives (M0.6).
- Starting or refreshing previews automatically on every push.
- Previews of PRs whose head branch lives in a fork: they are refused with `preview_pr_not_eligible`.
- The factory runtime itself (living spec, "Out of scope"). This change only states what `labctl` must do for
  OpenBinding previews.
