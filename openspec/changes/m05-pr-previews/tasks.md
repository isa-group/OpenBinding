# Tasks: m05-pr-previews

Each slice is ≤ 300 non-test diff lines and writes its tests first. Check commands run from the repository root.
Every pytest check of S1a and S2 is one argv of the form
`["uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", …]`: pytest
is only in the `test` extra, and each argv is one `qa_run`, so no separate sync step is assumed. Factory
prerequisites F1 and F2 live outside this repository.

Order: S1b+S3, then S1a+S2 (S2 is not merged until F1 is done), then F2, then S4 (F2's acceptance needs the
parameterised file of S2, and S4 follows S2 and F2), then the archive.

Tracing: `lab/` is not in the G6 OFT trace paths of `.agentic/project.yaml` (factory side), so the `[impl->…]` and
`[utest->…]` tags of `lab/tests/` and `lab/previews/` are not traced until those paths are added.

## S1b. Tests first, planner (~220 lines; ships in the S3 PR, never merged alone)
- [x] 1.3 `lab/tests/test_previews.py`: the planner tests named in the delta spec's `Evidence:` lines, each tagged
  `[utest->req~lab-deployment-preview-…~1]`. They drive the planner contract of design.md §1 through `subprocess`, so
  the file has no import of `lab/previews/` that could fail at collection.
- [x] 1.4 One shared helper, `run_planner(*args) -> tuple[int, dict | None]`, runs the planner with `sys.executable`
  and the path `Path(__file__).resolve().parents[2] / "lab" / "previews" / "previews.py"` built from the repository
  root (checks run from `openbinding-gateway/`, so no relative path), followed by `plan …`, and returns the exit code
  and the parsed stdout (`None` when stdout is not JSON; it never raises). Every test asserts on both:
  `returncode == 0` and the keys of the JSON, or, for the usage-error tests, `returncode == 64` (`EX_USAGE`,
  design.md §1) and `None`. Tests that loop over allocated ports assert the list is non-empty first.
  `test_missing_required_flag_is_a_usage_error` drops each required flag of design.md §1 in turn (for example
  `--now` of `request`) and expects 64; it is tagged `[utest->req~lab-deployment-preview-on-demand~1]`.
- [x] 1.5 Planner-layer proxy for deletion, element by element (so `--verbose` in a seed argument does not match
  `-v`): in the `commands` of `request`, `refresh`, `open`, `stop`, `activity` and `expire`, no argv has an element
  equal to `-v`, `--volumes`, `--rmi` or `rmi`, nor the consecutive elements `volume rm` or `image rm`; every
  deletion in `expire` is `["labctl", "destroy", "preview", "<n>"]`. In `destroy-check`, no `image rm` argv has `-f`
  or `--force`.
- [x] 1.6 Secret formats with `--seed-rng 7`: `DEMO_PG_PASSWORD` matches `[A-Za-z0-9._-]+`; `DEMO_FERNET_KEY` decodes
  as URL-safe base64 to 32 bytes; `DEMO_BIM_TOKEN` is 32–127 printable ASCII characters without spaces;
  `DEMO_SEED_PASSWORD` has ≥ 10 characters; PR 42 and PR 57 differ; PR 42 twice repeats.
- Acceptance: red on the base commit by assertion (G3): the expected red output is `AssertionError` only, with no
  `CalledProcessError`, `JSONDecodeError`, import or collection error. Every test of the file is expected red: the
  planner does not exist on the base, so Python exits 2 and `returncode == 0`, or `returncode == 64` for the
  usage-error tests, fails first. Check (red_before):
  `["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_previews.py"]`.

## S3. Planner (~160 lines + S1b)
- [x] 3.1 `lab/previews/previews.py`: stdlib only; `plan request|refresh|open|stop|expire|activity|destroy-check`
  with the flags, output keys, exit codes and check order of design.md §1. `activity` records one of
  `request`, `refresh`, `open`, `g12`, `screenshot` and refuses `g12` and `screenshot` on a stale head
  (`preview_head_stale`); any other `--kind` is a usage error (exit 64). Tags `[impl->req~lab-deployment-preview-…~1]`.
- Acceptance: every `test_previews.py` test passes: eligibility (closed, merged, fork), untracked file, on-demand,
  port allocation and its boundaries, names, synthetic environment and kept secrets, refresh and stale head, 168 h
  expiry and its boundaries, destroy only through `labctl destroy` and image ownership, the 9216 MiB cap and its
  boundaries, and port exhaustion. Check:
  `["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_previews.py"]`.

## F1. Factory: `lab_compose` accepts the parameterised file (prerequisite of merging S2)
- [ ] The validator accepts `published: "${DEMO_LAB_PORT:-18100}"` with the interpolated value in 18100–18199, the
  interpolated gateway image tag and a project-name argument, and keeps one environment per project.
- Acceptance: `lab_compose validate` passes on the S2 file. `lab_compose up` of the develop lab still publishes
  `127.0.0.1:18100`.

## S1a. Tests first, static rules (~120 lines; ships in the S2 PR, never merged alone)
- [x] 1.1 `lab/tests/test_lab_compose.py`. Helpers that break and how they change:
  - `_expand(value, supplied)` applies one value to every reference; it takes a per-variable mapping instead,
    `_expand(value, {"DEMO_LAB_PORT": …, "DEMO_PUBLIC_ORIGIN": …})`, and its two callers pass one.
  - `reference_name(body)` also drops the `DEMO_LAB_PORT:-18100` default; the allowed-defaults set of
    `test_only_the_public_origin_has_a_default_and_it_is_the_local_origin` becomes
    `{DEMO_PUBLIC_ORIGIN:-http://localhost:18100, DEMO_LAB_PORT:-18100}`.
  - The exact CORS strings of the raw comparisons (the `CORS_ALLOW_ORIGINS` entries of `PUBLIC_ORIGIN_VARIABLES`,
    read by `test_public_origin_reaches_gateway_worker_and_seed_by_interpolation`, and `test_gateway_environment`)
    become `http://localhost:${DEMO_LAB_PORT:-18100},http://127.0.0.1:${DEMO_LAB_PORT:-18100},${DEMO_PUBLIC_ORIGIN}`
    and stay raw. `LOCAL_CORS` keeps the expanded 18100 form that the two `_expand` tests compare against. The
    expanded comparison for 18101 and 18199 is only in `test_gateway_image_tag_and_local_cors_follow_the_port`.
  - `int(port['published'])` and `ports[0][1] == PUBLISHED` in `test_single_published_port_on_loopback` read the
    expanded value; the rule becomes a function `_assert_single_loopback_port(services, supplied="18100")` that
    checks `published` is all digits before `int()`, so `abc` fails by assertion, that it is in 18100–18199 (both
    failures with a message naming the range), and that it equals the supplied port, not only that it is in range.
    It reads `published` as `str(port["published"])` (the base has the int 18100) before expanding and before the
    digits check, and compares strings, `published == str(supplied)`, so no `int()` of `supplied` can raise.
  - A helper `_rule_failure(services, supplied) -> str | None` returns the `AssertionError` message of
    `_assert_single_loopback_port` or `None`. The refusal tests assert on it (`assert msg is not None` and, for the
    range test, the range in `msg`) instead of `pytest.raises`, so their red on the base is an `AssertionError`, never
    `Failed: DID NOT RAISE`.
  - The literal `openbinding-lab-gateway:latest` of `test_gateway_worker_and_seed_share_one_always_rebuilt_image`
    becomes the expanded `openbinding-lab-gateway:<port>`.
  - New tests: `test_single_published_port_on_loopback` parameterised over unset, 18101 and 18199;
    `test_published_port_outside_the_range_is_refused` (18099, 18200, `abc`);
    `test_gateway_image_tag_and_local_cors_follow_the_port`; `test_demo_doc_has_the_demo_lab_port_row`, which
    requires a row starting with `` | `DEMO_LAB_PORT` `` naming 18100 and 18101–18199 unconditionally (the generic
    loop of `test_demo_doc_states_the_memory_sum_and_every_demo_variable` passes on the base, which has no reference);
    and the negative control `test_port_rule_refuses_an_extra_published_port`, which applies `_rule_failure` to a
    copy of the manifest with an extra `8000:8000` on the gateway and asserts a message. On the base, the range test
    is red because the literal 18100 differs from the supplied 18099, 18200 or `abc` and that message does not name
    the range. Tag `[utest->req~lab-deployment-single-loopback-port~2]`.
- [x] 1.2 `openbinding-gateway/tests/test_container_hardening.py`: `SHARED_IMAGE` becomes
  `openbinding-lab-gateway:${DEMO_LAB_PORT:-18100}`; `ALLOWED_DEFAULT_REFERENCE` becomes a set with
  `DEMO_LAB_PORT:-18100` added. `lab/tests/test_lab_compose.py` gets the constant
  `PUBLISHED_REFERENCE = {"target": 8080, "published": "${DEMO_LAB_PORT:-18100}", "host_ip": "127.0.0.1"}`, the raw
  published reference; `lab/tests/test_lab_process_profiles.py` (line ~223) compares `ports` with
  `[("web", rules.PUBLISHED_REFERENCE)]` in `test_only_the_gateway_holds_the_jwt_secret_and_one_port_is_published`.
  `PUBLISHED` stays the dict with the int `published` 18100 for its other uses: the `target` reads, and the expanded
  unset comparison, which checks `int(published) == PUBLISHED["published"]`, `host_ip` and `target` field by field
  instead of comparing dicts (the expanded value is a string).
- [x] 1.7 `lab/tests/test_lab_compose_config.py` (new): runs
  `docker compose -f compose.lab.json --profile seed config --format json` (without `--profile seed` the rendered file
  has no `seed` service) unset, with `DEMO_LAB_PORT=18101` and with `18199`, and compares `web`'s published port and
  host, the image of gateway, worker and seed, and the gateway's `CORS_ALLOW_ORIGINS` with the expected values. It
  runs only when `OPENBINDING_COMPOSE_CONFIG=1`; with that variable set, a missing `docker` fails it.
- Expected red on the base (G3), by assertion only: the 18101 and 18199 cases of
  `test_single_published_port_on_loopback`; `test_published_port_outside_the_range_is_refused`;
  `test_gateway_image_tag_and_local_cors_follow_the_port`; `test_demo_doc_has_the_demo_lab_port_row`;
  `test_only_the_public_origin_has_a_default_and_it_is_the_local_origin`;
  `test_gateway_worker_and_seed_share_one_always_rebuilt_image`; `test_gateway_environment` and
  `test_public_origin_reaches_gateway_worker_and_seed_by_interpolation` (raw CORS strings);
  `test_only_the_gateway_holds_the_jwt_secret_and_one_port_is_published`; the hardening tests that go through
  `_gateway_image_services` (`SHARED_IMAGE`); and, with `OPENBINDING_COMPOSE_CONFIG=1`, every case of
  `test_compose_config_expands_port_image_and_cors` (the base image tag is still `latest`). Expected green on the
  base: the unset (18100) case of `test_single_published_port_on_loopback`, the negative control
  `test_port_rule_refuses_an_extra_published_port`, `test_unset_or_empty_public_origin_leaves_the_local_lab`,
  `test_a_public_origin_replaces_the_urls_and_is_appended_to_the_local_cors_origins` and
  `test_compose_holds_no_literal_secret`.
  Checks (red_before):
  `["uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_lab_compose.py", "../lab/tests/test_lab_process_profiles.py", "tests/test_container_hardening.py"]`;
  `["env", "OPENBINDING_COMPOSE_CONFIG=1", "uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", "-rs", "../lab/tests/test_lab_compose_config.py"]`.

## S2. Compose parameterisation (~75 lines + S1a; merged only after F1)
- [x] 2.1 `compose.lab.json`, `compose.lab-process.json`, `compose.lab-process-n2.json`,
  `compose.lab-process-n1-probe.json`, `compose.lab-process-n2-probe.json`: `DEMO_LAB_PORT` in `published`, in the
  three gateway image tags and in the two local CORS lists (design.md §5).
  The probe profiles (`-n1-probe`, `-n2-probe`) are covered transitively: the process-profile rules run on them in
  `lab/tests/test_lab_process_n1_probe_profile.py` and `test_lab_process_probe_profile.py`, and each equals N1 or N2
  plus one line.
- [x] 2.2 `docs/DEMO.md`: a `DEMO_LAB_PORT` row (default 18100, PR previews 18101–18199) and the new image tag.
- Acceptance: all lab static rules pass, and the develop lab expands to exactly today's port, origins and volumes.
  Checks:
  `["uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests", "tests/test_container_hardening.py"]`;
  `["env", "DEMO_LAB_PORT=18101", "docker", "compose", "-f", "compose.lab.json", "--profile", "seed", "config", "--format", "json"]`;
  `["docker", "compose", "-f", "compose.lab.json", "--profile", "seed", "config", "--format", "json"]`;
  `["env", "OPENBINDING_COMPOSE_CONFIG=1", "uv", "run", "--directory", "openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", "-rs", "../lab/tests/test_lab_compose_config.py"]`
  with 0 skipped. The two bare `docker compose … config` checks are MRP evidence only (they prove exit 0 and show the
  rendered file); the assertion on port, image and CORS is the last pytest check. After F1, `lab_compose validate`
  passes.

## F2. Factory: `labctl preview` and `labctl destroy preview` (prerequisite of S4)
- [ ] The state store, activity recording, the eligibility and stale-head checks, the hourly sweep, memory admission,
  the port probe, per-preview secrets kept until destroy, image ownership by ID, and G12 on the preview project, all
  implemented against the planner's rules.
- [ ] Retire the unused `openbinding-lab-gateway:latest` image after S2 through a maintenance operation
  (constitution 18.3), not an ad-hoc `docker rmi`.
- Acceptance: a preview of a real PR comes up on 18101, the seed passes, `smoke_lab.py` passes 9/9 and G12 runs on
  it. The develop lab on 18100 is untouched. A push to a PR without a preview starts nothing. The stored environment
  of that preview meets the secret format rules of design.md §5, and the destroy of a preview whose gateway image ID
  equals the develop lab's leaves `openbinding-lab-gateway:18100` in place. After `refresh` and
  `stop` every `openbinding-pr-<n>_*` volume still exists; a refresh whose build fails leaves the old head serving;
  after `labctl destroy preview <pr>` no `openbinding-pr-<n>_*` volume is left.

## S4. Docs and live probe (~110 lines)
- [x] 4.1 `lab/tests/test_preview_isolation.py`: the live probe of design.md §8, tagged
  `[utest->req~lab-deployment-preview-isolation~1]`. It runs only when `OPENBINDING_LAB_PROBE=1`; with it set, a
  missing lab fails. Precondition: the develop lab stopped, or two small stand-in projects named `openbinding-pr-*`.
  Client: a `python -c` socket connect run with `docker exec` in A's `gateway` container, printing `ok` or the errno
  name. Negative: from a container of A, B's port is refused through the host-side gateway address of A's network,
  and the client prints `ECONNREFUSED` (a timeout, another errno or an exec error fails the test). Controls: the
  client connects to A's own `web:8080`; B's port answers from the host at `127.0.0.1:<B port>`; A's `web` resolves
  to A's own container address, which differs from B's.
  Note: F1 and F2 are still pending and live outside the repository, so the preview docs state the plan truthfully.
  `docs/qa/E2E_PLAN.md` and `TESTING.md` naming the preview port, and the ARCHITECTURE §10 row, are follow-ups
  outside this change.
- [ ] 4.2 `docs/previews/README.md` changes from plan to in force. `docs/DEMO.md` gets a "PR previews" section.
  `TESTING.md` and `docs/qa/E2E_PLAN.md` name the preview port.
- [ ] 4.3 Follow-up for the coordinator (ARCHITECTURE.md is outside this change): extend the ARCHITECTURE §10 row
  "Lab previews" to cover images, the work tree and the state record.
- Acceptance: `["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests"]` passes, and
  `["env", "OPENBINDING_LAB_PROBE=1", "OPENBINDING_PROBE_PROJECT_A=openbinding-pr-<a>", "OPENBINDING_PROBE_PROJECT_B=openbinding-pr-<b>", "OPENBINDING_PROBE_PORT_A=<18101-18199>", "OPENBINDING_PROBE_PORT_B=<18101-18199>", "uv", "run", "--locked", "--extra", "test", "pytest", "-q", "-rs", "../lab/tests/test_preview_isolation.py"]`
  passes in the lab with 0 skipped. Every `GAP` in the delta spec is replaced by a test path before the archive.

## A. Archive (after S4, explicit archive task)
- [ ] `["openspec", "archive", "m05-pr-previews", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.
- [ ] In `openspec/specs/lab-deployment/spec.md`, reword the Purpose to name `127.0.0.1:18100` for the develop lab
  plus 18101–18199 for PR previews, and the Out of scope line to "The factory's own runtime on NiPoGi, except the
  preview rules mirrored by `lab/previews`".

G1 for this change: `["openspec", "validate", "m05-pr-previews", "--strict"]`.
