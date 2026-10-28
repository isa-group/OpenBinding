# Tasks: m0-infra-close

The infra tail of M0: follow-ups F1, F4, F5, F7 and F9 of `m09-compose-only` (its tasks.md, lines 109-140), and tasks
4.2 and 4.3 of `m05-pr-previews`. Each slice has one capability. It merges into `develop` as its own PR and stays
within about 300 changed lines. Slices that share a file run in order: S1 before S2 and S3
(`docs/runbooks/production.md`, `openspec/changes/m09-compose-only/tasks.md`), and S1 before S2 (`README.md`,
`deploy/compose/production/compose.yaml`, `openbinding-gateway/tests/test_compose_production.py`).
- Only S0 and S1 are built now. S2, S3 and S4 are `blocked on <decision>`: they stay unchecked and nobody builds them
  until the decision is recorded.
- Tests are written first, and they run red on the slice's base by assertion (G3), except negative controls, which are
  named.
- Workers have no Docker. Every render and every container check is done in the lab by the coordinator (design.md §3).

Checks to register. The argv is listed; `cwd` is the repository root.
1. G1: `["openspec","validate","m0-infra-close","--strict"]`.
2. G9: `["git","diff","--check"]`.
3. S1 static tests: `["uv","run","--project","openbinding-gateway","--locked","--extra","test","pytest","-q","openbinding-gateway/tests/test_production_nginx.py","openbinding-gateway/tests/test_compose_production.py","openbinding-gateway/tests/test_no_kubernetes.py"]`.
4. S1 ruff: `["uv","run","--project","openbinding-gateway","--locked","--extra","test","ruff","check","openbinding-gateway/tests/test_production_nginx.py"]`.
5. S3 static tests: `["uv","run","--project","openbinding-gateway","--locked","--extra","test","pytest","-q","lab/tests/test_ci_compose_config.py","lab/tests/test_ci_gate_tooling.py"]`.

## S0. Specification (specifier)

Owned: `openspec/changes/m0-infra-close/proposal.md`, `design.md`, `tasks.md`, `specs/lab-deployment/spec.md`.

- [x] 0.1 `proposal.md`, `design.md` (D1 to D6, what is verified where, risks, rollback, Q1) and `tasks.md`.
- [x] 0.2 Delta `specs/lab-deployment/spec.md`: one ADDED requirement, `req~lab-deployment-compose-config-in-ci~1`.
  Its `Evidence:` names the S3 files, which do not exist yet.
- [ ] 0.3 Check 1 green, then the G2 EPIC review by the spec-auditor. The owner or coordinator answers design.md §6 Q1.

## S1. Nginx request-time resolution (F9), Kubernetes notes (F5) and README pointer

Owned:
- `openbinding-gateway/tests/test_production_nginx.py` (new, written first; design.md D5);
- `nginx/production/nginx.conf` (design.md D1, D2);
- `deploy/compose/production/compose.yaml`: only the comment at line 353 that says nginx resolves `gateway` once.
  `restart: true` stays (`req~lab-deployment-production-health-restart~1`);
- `openbinding-gateway/tests/test_compose_production.py`, edited before the runbook (item 1.1):
  - the comment at line 600 and the docstring of `gateway_restart_problems` (line 2283), which say nginx resolves the
    gateway once;
  - `test_runbook_says_that_only_nginx_restarts_with_the_gateway_and_that_a_daemon_restart_needs_a_manual_one`
    (lines 2932-2947) is renamed to `test_runbook_says_that_only_nginx_restarts_with_the_gateway_and_that_nginx_re_resolves_it`.
    Its assertions change:
    - the needle `"F9"` of the section "502 after a gateway restart" becomes `"10 s"`;
    - `"#502-after-a-gateway-restart" in section(text, "What stays blocked")` becomes
      `"Nginx resolves the gateway once" not in section(text, "What stays blocked")`;
    - the assertions on "What is deployed" (`restart: true`, the workers, the anchor link) stay.
  - `gateway_restart_problems` and its tests stay: every recreation of the gateway in the runbook is still followed by
    `$DC restart nginx`. So does `test_runbook_follow_up_f7_and_the_trace_follow_up_are_recorded_in_the_tasks`
    (line 2925), which needs `F9`, `R2-REV-002` and `resolver` in `m09-compose-only/tasks.md`;
- `docs/runbooks/production.md`:
  - lines 48-51: nginx re-resolves `gateway` within 10 s. The sentence "`nginx` therefore depends on `gateway` with
    `restart: true`" and the link to `#502-after-a-gateway-restart` stay;
  - line 594, and the section "502 after a gateway restart" (lines 410-426): its heading stays (the anchor is linked
    from "What is deployed"). The text says that nginx reaches a recreated gateway within 10 s. A 502 that lasts more
    than 10 s after the gateway is healthy is a new incident, and `$DC restart nginx` is its first step. The section
    keeps the words "crash or an out-of-memory kill" and "502 Bad Gateway", and drops the F9 follow-up sentence
    (lines 424-425). The explicit `$DC restart nginx` lines of the procedures stay, because they are harmless and also
    reload the configuration;
  - the bullet "Nginx resolves the gateway once" of "What stays blocked" (lines 757-760) goes;
- `bim-toolchain/docs/SERVICE.md`: line 742 and lines 751-755 (design.md D3);
- `README.md`: one sentence after line 126 (design.md D4);
- `openspec/changes/m09-compose-only/tasks.md`: F5 and F9 are checked, each with "done in `m0-infra-close` S1". Their
  text stays (line 2925 of `test_compose_production.py` reads it).

No other file changes.

- [ ] 1.1 Test first: `test_production_nginx.py` reads `nginx/production/nginx.conf` and checks:
  - the `resolver 127.0.0.11 valid=10s ipv6=off;` line;
  - every `proxy_pass` uses `$gateway_upstream`, and no `proxy_pass` names `gateway:8000` literally;
  - the `/api/` `proxy_pass` ends with the variable mapped from `$request_uri`, the `map` strips `^/api` and has an
    empty default, and the location returns 400 on the empty value;
  - no `rewrite` directive in the file.

  Each rule is also applied to an in-memory copy that breaks it: the literal `proxy_pass`, no resolver, a `rewrite`.
  The test fails on that copy. On the base the test is red by assertion (no resolver). The mutated-copy cases are
  negative controls and pass on the base. The tests carry no `[utest->…]` tag (design.md D5).

  In the same item, the `test_compose_production.py` edits listed above. The changed runbook test is red on the base
  by assertion: the base runbook still has the bullet "Nginx resolves the gateway once", and its section "502 after a
  gateway restart" has no "10 s".
- [ ] 1.2 `nginx/production/nginx.conf`: D1 and D2. The `/static/` and `/avatars/` locations keep a `proxy_pass`
  without a URI.
- [ ] 1.3 The comments of `compose.yaml:353` and `test_compose_production.py:600`, and the runbook edits listed above.
- [ ] 1.4 F5: `bim-toolchain/docs/SERVICE.md` as in design.md D3. MRP evidence:
  `git grep -n -i kubernetes -- bim-toolchain/docs/SERVICE.md` prints nothing.
- [ ] 1.5 `README.md` pointer (D4), and the F5 and F9 lines of `m09-compose-only/tasks.md`.
- [ ] 1.6 Checks 3, 4 and 2. Review panel: reviewer and security-auditor (the public proxy changes).
- [ ] 1.7 Lab, by the coordinator, before merge: the F9 procedure of design.md §3, with the image built from the S1
  head. The MRP records the request lines that the stand-in logged, the 400, and the request after the gateway was
  replaced.

## S2. `prod` profile (F4) and non-root engines (F7): blocked on CRP-M09-2

Owner decision CRP-M09-2 (`m09-compose-only`, design.md §4 and §10): keep the production definition standalone and
remove the `prod` profile, or turn production into an override of `docker-compose.yml`. Nothing in S2 starts before
the answer is recorded.

Owned (planned): `docker-compose.yml`, `README.md:118-131`, the comment of `.github/workflows/ci.yml:404-411` if
the `prod` profile goes (a workflow edit, so it also needs CRP-M09-3), `deploy/compose/production/compose.yaml`
(`user` and `cap_drop` for the Java engines, `nginx` and `frontend-assets`), `docs/runbooks/production.md` ("What
stays blocked"), `openbinding-gateway/tests/test_compose_production.py`, and the F4 and F7 lines of
`m09-compose-only/tasks.md`.

- [ ] 2.1 blocked on CRP-M09-2: F4, remove or rename the `prod` profile of `docker-compose.yml`, as the answer says.
- [ ] 2.2 blocked on CRP-M09-2: F7, a `user` and `cap_drop: [ALL]` for the Java engines, `nginx` and
  `frontend-assets`, with the capabilities each one needs added back. The tests come first, and the lab renders and
  starts the result on a host with Docker.

## S3. CI job `compose-config` (F1): blocked on CRP-M09-3

Pushing a change under `.github/workflows/**` needs a token with Workflows: write (CRP-M09-3). This slice builds the
evidence of `req~lab-deployment-compose-config-in-ci~1`. Until it merges, the requirement has no implementation, and
the M0.9 acceptance "`docker compose config` passes in CI for development, lab and production" is met for development
only.

Owned (planned): `.github/workflows/ci.yml` (the new job `compose-config` and its entry in the `needs` of
`ci-required`), `lab/tests/test_ci_compose_config.py` (new), `docs/runbooks/production.md` (the bullet "CI
compose-config job" of "What stays blocked"), and the F1 line of `m09-compose-only/tasks.md`.

- [ ] 3.1 blocked on CRP-M09-3: test first, `lab/tests/test_ci_compose_config.py`, tagged
  `[utest->req~lab-deployment-compose-config-in-ci~1]`. It reads `ci.yml` and covers every scenario of the
  requirement that a static test can check (design.md D6): the three renders with `--quiet`, `--profile dev`, the two
  production env files, the `compose.lab*.json` glob, the `ci-required` entry, and no change-detection gate. It also
  checks a mutated copy for each of them. Red on the base: there is no job.
- [ ] 3.2 blocked on CRP-M09-3: the job `compose-config` of design.md D6, tagged
  `# [impl->req~lab-deployment-compose-config-in-ci~1]`.
- [ ] 3.3 blocked on CRP-M09-3: checks 5 and 2. The CI run of the pull request shows the job green. A throwaway
  commit on the same branch that breaks `compose.yaml` (the "Malformed production file" scenario) shows the job and
  `ci-required` red, and is then dropped. The MRP links both runs.
- [ ] 3.4 blocked on CRP-M09-3: owner, outside this change (`m09-compose-only` F2): add the lab and production `compose config` checks to
  `.agentic/project.yaml:81`, and update the evidence line of ADR-0021 (`docs/adr/0021-docker-compose-only.md:54`).

## S4. Preview documentation (`m05-pr-previews` 4.2 and 4.3): blocked on factory F2

The preview docs can say "in force" only when `labctl preview` and `labctl destroy preview` exist (factory
prerequisite F2 of `m05-pr-previews`, outside this repository).

Owned (planned): `docs/previews/README.md`, `docs/DEMO.md` (a "PR previews" section), `TESTING.md`,
`docs/qa/E2E_PLAN.md`, and tasks 4.2 and 4.3 of `m05-pr-previews/tasks.md`.

- [ ] 4.1 blocked on factory F2: `m05-pr-previews` 4.2. `docs/previews/README.md` changes from plan to in force,
  `docs/DEMO.md` gets a "PR previews" section, and `TESTING.md` and `docs/qa/E2E_PLAN.md` name the preview port range
  18101-18199.
- [ ] 4.2 blocked on factory F2: `m05-pr-previews` 4.3, a coordinator follow-up. The ARCHITECTURE §10 row "Lab
  previews" covers images, the work tree and the state record. `docs/ARCHITECTURE.md` is outside the owned files above.
- [ ] 4.3 blocked on factory F2: check 2.

## A. Archive (explicit archive task, after S1 and S3)

- [ ] `["openspec","archive","m0-infra-close","--yes"]`, then `["openspec","validate","--all","--strict"]`. The
  archive waits for S3, because the requirement's `Evidence:` files are built there. If CRP-M09-3 is never answered,
  the archive task records that and leaves the change open.

## Follow-ups outside this change

- Carry the F5 edit of `bim-toolchain/docs/SERVICE.md` to `isa-group/bim-toolchain` (design.md §4, R4).
- Request-time resolution for `frontend/nginx.lab.conf` and `nginx/local/nginx.conf`. They have the same
  resolve-once behaviour, and the lab one also strips `/api/` with a prefix-replacing `proxy_pass`.
- `m09-compose-only` F2, F3, F6 and F8 stay with that change and the owner.
