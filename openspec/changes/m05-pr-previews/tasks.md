# Tasks: m05-pr-previews

Each slice is ≤ 300 diff lines and writes its tests first. Check commands run from `openbinding-gateway/` with its
environment (`uv sync --locked --extra test` first). Factory prerequisites F1 and F2 live outside this repository.

## F1. Factory: `lab_compose` accepts the parameterised file (prerequisite of S2)
- [ ] The validator accepts `published: "${DEMO_LAB_PORT:-18100}"` with the interpolated value in 18100–18199, the
  interpolated gateway image tag and a project-name argument, and keeps one environment per project.
- Acceptance: `lab_compose validate` passes on the S2 file. `lab_compose up` of the develop lab still publishes
  `127.0.0.1:18100`.

## S1a. Tests first, static rules (~90 lines; ships in the S2 PR, never merged alone)
- [ ] 1.1 `lab/tests/test_lab_compose.py`: port, image and CORS checked after expansion (unset → 18100; 18101 and
  18199 set). Allowed defaults are `{DEMO_PUBLIC_ORIGIN:-http://localhost:18100, DEMO_LAB_PORT:-18100}`.
  `DEMO_LAB_PORT` is documented in `docs/DEMO.md`. Tag `[utest->req~lab-deployment-single-loopback-port~2]`.
- [ ] 1.2 `openbinding-gateway/tests/test_container_hardening.py` and `lab/tests/test_lab_process_profiles.py`:
  `SHARED_IMAGE`, `PUBLISHED` and the allowed default references follow the new forms.
- Acceptance: red on the base commit by assertion (G3). Check (red_before):
  `["uv", "run", "--locked", "pytest", "-q", "../lab/tests/test_lab_compose.py", "../lab/tests/test_lab_process_profiles.py", "tests/test_container_hardening.py"]`.

## S2. Compose parameterisation (~75 lines + S1a)
- [ ] 2.1 `compose.lab.json`, `compose.lab-process.json`, `compose.lab-process-n2.json`,
  `compose.lab-process-n1-probe.json`, `compose.lab-process-n2-probe.json`: `DEMO_LAB_PORT` in `published`, in the
  three gateway image tags and in the two local CORS lists (design.md §5).
- [ ] 2.2 `docs/DEMO.md`: a `DEMO_LAB_PORT` row (default 18100, PR previews 18101–18199) and the new image tag.
- Acceptance: all lab static rules pass, and the develop lab expands to exactly today's port, origins and volumes.
  Checks: `["uv", "run", "--locked", "pytest", "-q", "../lab/tests", "tests/test_container_hardening.py"]`, then
  `["docker", "compose", "-f", "../compose.lab.json", "config", "--quiet"]` with and without `DEMO_LAB_PORT=18101`.
  After F1, `lab_compose validate` passes.

## S1b. Tests first, planner (~170 lines; ships in the S3 PR, never merged alone)
- [ ] 1.3 `lab/tests/test_previews.py`: one test per ADDED requirement, named as in the delta spec's `Evidence:`,
  each tagged `[utest->req~lab-deployment-preview-…~1]`. It calls the planner CLI through `subprocess` on a state
  document and asserts on its JSON, so it has no import of `lab/previews/` that could fail at collection.
- Acceptance: red on the base commit by assertion (G3), with no import or collection error. Check (red_before):
  `["uv", "run", "--locked", "pytest", "-q", "../lab/tests/test_previews.py"]`.

## S3. Planner (~130 lines + S1b)
- [ ] 3.1 `lab/previews/previews.py`: stdlib only; `plan request|refresh|open|stop|expire` over a state document;
  JSON output; tags `[impl->req~lab-deployment-preview-…~1]`.
- Acceptance: every `test_previews.py` test passes, covering the untracked-file refusal, on-demand, port range, isolation names, synthetic
  environment, refresh, 168 h expiry, destroy only through `labctl destroy`, the 9216 MiB cap and 99-port
  exhaustion. Check: `["uv", "run", "--locked", "pytest", "-q", "../lab/tests/test_previews.py"]`.

## F2. Factory: `labctl preview` and `labctl destroy preview` (prerequisite of S4)
- [ ] The state store, activity recording, hourly sweep, memory admission, port probe, per-preview secrets, and G12
  on the preview project, all implemented against the planner's rules.
- Acceptance: a preview of a real PR comes up on 18101, the seed passes, `smoke_lab.py` passes 9/9 and G12 runs on
  it. The develop lab on 18100 is untouched. `labctl destroy preview <pr>` leaves no `openbinding-pr-<n>_*` volume.

## S4. Docs and live probe (~90 lines)
- [ ] 4.1 `lab/tests/test_preview_isolation.py`: a live probe, skipped without a lab. From a container of preview A,
  `web` resolves to A's own service. B's published port is unreachable through the host-side gateway address of A's
  network (not `127.0.0.1`, which is A's own loopback).
- [ ] 4.2 `docs/previews/README.md` changes from plan to in force. `docs/DEMO.md` gets a "PR previews" section.
  `TESTING.md` and `docs/qa/E2E_PLAN.md` name the preview port.
- Acceptance: `["uv", "run", "--locked", "pytest", "-q", "../lab/tests"]` passes, and the probe passes in the lab.
  Every `GAP` in the delta spec is replaced by a test path before the archive.

## A. Archive (after S4, explicit archive task)
- [ ] `["openspec", "archive", "m05-pr-previews", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

G1 for this change: `["openspec", "validate", "m05-pr-previews", "--strict"]`.
