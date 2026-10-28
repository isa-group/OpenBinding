# Tasks: m0-infra-close

The infra tail of M0: follow-ups F1, F4, F5, F7 and F9 of `m09-compose-only` (its tasks.md, lines 109-140), and tasks
4.2 and 4.3 of `m05-pr-previews`. Each slice has one capability and stays within about 300 changed lines. Slices
that share a file run in order: S1b before S2 and S3 (`docs/runbooks/production.md`,
`openspec/changes/m09-compose-only/tasks.md`), S1b before S2 (`deploy/compose/production/compose.yaml`,
`openbinding-gateway/tests/test_compose_production.py`), and S1 before S2 (`README.md`).
- S0, S1 and S1b are built (owner decision "Full": F5 and F9 close completely in this change). The R1 fix round of
  the review panel on head 2b89ef9f (section R1 below) is delivered and integrated (head f628c612). CI ran
  `test_production_nginx.py` and `test_compose_production.py` green in the gateway-unit shards, and the openspec and
  trace jobs are green. What stays open has no evidence yet: the ruff check, the pre-deployment check 1b.7, S3 and the owner
  questions. S2, S3 and S4 are `blocked on <decision>`: they stay unchecked and nobody builds them until the
  decision is recorded.
- Tests are written first, and they run red on the slice's base by assertion (G3), except negative controls, which are
  named, and `test_production_nginx.py`, which follows the S1 code (S1b, item 1b.1).
- Workers have no Docker. The container checks of F9 are the pre-deployment check of the runbook (design.md §3); the
  factory did not run them. The Compose renders of S3 run in CI.

Checks to register. The argv is listed; `cwd` is the repository root.
1. G1: `["openspec","validate","m0-infra-close","--strict"]`.
2. G9: `["git","diff","--check"]`.
3. S1b static tests: `["uv","run","--project","openbinding-gateway","--locked","--extra","test","pytest","-q","openbinding-gateway/tests/test_production_nginx.py","openbinding-gateway/tests/test_compose_production.py","openbinding-gateway/tests/test_no_kubernetes.py"]`.
4. S1b ruff: `["uv","run","--project","openbinding-gateway","--locked","--extra","test","ruff","check","openbinding-gateway/tests/test_production_nginx.py"]`.
5. S3 static tests: `["uv","run","--project","openbinding-gateway","--locked","--extra","test","pytest","-q","lab/tests/test_ci_compose_config.py","lab/tests/test_ci_gate_tooling.py"]`.

## S0. Specification (specifier)

Owned: `openspec/changes/m0-infra-close/proposal.md`, `design.md`, `tasks.md`, `specs/lab-deployment/spec.md`.

- [x] 0.1 `proposal.md`, `design.md` (D1 to D6, what is verified where, risks, rollback, Q1) and `tasks.md`.
- [x] 0.2 Delta `specs/lab-deployment/spec.md`: one ADDED requirement, `req~lab-deployment-compose-config-in-ci~1`.
  Its `Evidence:` names the S3 files, which do not exist yet. The R1 fix round adds the second one (R1.1).
- [ ] 0.3 Check 1 green, then the G2 EPIC review by the spec-auditor. The owner or coordinator answers design.md §6 Q1.

## S1. Nginx request-time resolution (F9), Kubernetes notes (F5) and README pointer (built)

Owned: `nginx/production/nginx.conf` (design.md D1, D2), `bim-toolchain/docs/SERVICE.md` (D3), `README.md` (D4).

- [x] 1.1 `nginx/production/nginx.conf`: the `resolver` and `set $gateway_upstream http://gateway:8000;` at server
  level, the `/api` `map` on `$request_uri`, the 400 on its empty value, `proxy_pass $gateway_upstream$gateway_api_uri;`
  for `/api/` and `proxy_pass $gateway_upstream;` (no URI) for `/static/` and `/avatars/`.
- [x] 1.2 F5: `bim-toolchain/docs/SERVICE.md` line 742 and the former "Kubernetes notes" (now "Operation notes", lines 751-754) as
  in design.md D3.
  `git grep -n -i kubernetes -- bim-toolchain/docs/SERVICE.md` prints nothing.
- [x] 1.3 `README.md`: one sentence after line 126, "The project deploys with Docker Compose only", with the link to
  `bim-toolchain/docs/SERVICE.md`.

## S1b. Runbook, stale F9 phrases, nginx static test and the m09 follow-ups

Owned:
- `openbinding-gateway/tests/test_production_nginx.py` (new; design.md D5);
- `openbinding-gateway/tests/test_compose_production.py`: the phrases made stale by F9, that is the comment at line
  600, the docstring of `gateway_restart_problems` (line 2283), and the runbook test of lines 2932-2947, whose needle
  `"F9"` and whose link from "What stays blocked" pin F9 as open. `gateway_restart_problems` and its tests stay. So
  does `test_runbook_follow_up_f7_and_the_trace_follow_up_are_recorded_in_the_tasks` (line 2925), which reads `F9`,
  `R2-REV-002` and `resolver` in `m09-compose-only/tasks.md`;
- `docs/runbooks/production.md`;
- `deploy/compose/production/compose.yaml`: only the nginx `depends_on` comment (lines 353-356) that says nginx resolves `gateway`
  once. `restart: true` stays (`req~lab-deployment-production-health-restart~1`);
- `openspec/changes/m09-compose-only/tasks.md`: the F5 and F9 lines.

No other file changes.

- [x] 1b.1 `test_production_nginx.py` reads `nginx/production/nginx.conf` and pins: the
  `resolver 127.0.0.11 valid=10s ipv6=off;` line; `$gateway_upstream` in every `proxy_pass`, with no literal
  `gateway:8000` in any of them; no `rewrite` directive; the `/api` `map` on `$request_uri`, which strips `^/api`, has
  an empty default and feeds the `/api/` `proxy_pass`. Each rule is also applied to an in-memory copy that breaks it
  (a literal `proxy_pass`, no resolver, a `rewrite`, a `map` on `$uri`), and the test fails on that copy. The S1 code
  is already in, so these mutated-copy cases are the evidence that the test detects each defect. The R1 fix round
  adds the `[utest->req~lab-deployment-production-proxy-upstream~1]` tag (design.md D5, R1.2).
- [x] 1b.2 `test_compose_production.py`: the stale phrases above, and the runbook test now pins that nginx follows
  the gateway at request time and that "What stays blocked" no longer lists F9. Red on the base runbook by assertion.
- [x] 1b.3 `docs/runbooks/production.md`: nginx follows the gateway address at request time (`valid=10s`). The
  `$DC restart nginx` steps after a recreation of the gateway stay as a precaution; the runbook does not call them
  "harmless" (`test_compose_production.py:2882`, R2-SEC-001). The resolve-once statements (`:48`, `:412`, `:594`),
  the F9 follow-up sentences and the "What stays blocked" bullet on F9 go; the heading "502 after a gateway restart"
  stays (its anchor is linked).
- [x] 1b.4 The nginx `depends_on` comment of `compose.yaml` (lines 353-356).
- [x] 1b.5 `m09-compose-only/tasks.md`: F5 and F9 checked, each with "done in `m0-infra-close`". Their text keeps
  `F9`, `R2-REV-002` and `resolver`.
- [ ] 1b.6 Checks 3, 4 and 2. Review panel: reviewer and security-auditor (the public proxy changes).
  - [x] Check 3: CI on head f628c612 ran both test files green in the gateway-unit shards.
  - [ ] Check 4 (ruff) has no evidence yet. Check 2 is open. The panel round 2 approved head f628c612; round 3 (docs
    delta) is in progress.
- [ ] 1b.7 Not run by the factory (its lab brings up only tracked Compose files). Delegated to the operator as the
  pre-deployment check "Nginx check before the first deployment of this configuration" of
  `docs/runbooks/production.md`: the F9 procedure of design.md §3. Steps 1 to 7 use a stand-in gateway and run before
  the first deployment of this configuration (request lines, the 400, the request after the stand-in was replaced as
  `GET /health`, the 502 with its time when no `gateway` exists). Step 8 uses the real gateway and runs after the first
  deployment of the release (the two example requests through nginx and direct, the answers to `//v1/jobs` and
  `/v1/x/../jobs`, the restart of the gateway container without a restart of nginx). The operator records the results
  in the deployment notes. None of it was run in a real nginx by the factory. Evidence limitation, not a waived gate:
  until then F9 is verified by the static tests and the review panel only. Stays unchecked until the operator's result
  is known.

## R1. Fix round 1 of the review panel (head 2b89ef9f)

Owned: this change's documents (R1.1), and, in a parallel task, `nginx/production/nginx.conf`,
`openbinding-gateway/tests/test_production_nginx.py`, `docs/runbooks/production.md`, the nginx
`depends_on` comment of `deploy/compose/production/compose.yaml` (lines 353-356) and `openspec/changes/m09-compose-only/tasks.md` (R1.2).

- [x] R1.1 Specification (R1-ARC-001 to R1-ARC-006, R1-REV-003, R1-REV-005, R1-SEC-001, R1-SEC-002): the ADDED
  requirement `req~lab-deployment-production-proxy-upstream~1`; D1 (`resolver_timeout 5s`, the rejected `upstream`
  option reworded, the restart precaution and what a restart applies); D5; D6 (profile choice); the lab step 7 for a
  stopped gateway and its hardening note; R2 corrected; R6; Q1 and Q2; this section. Check 2.
- [x] R1.2 (delivered; CI on head f628c612: `test_production_nginx.py` and `test_compose_production.py` green in the
  gateway-unit shards; the ruff check, check 4, has no evidence yet) Code and docs (parallel task): `resolver_timeout 5s` and
  `# [impl->req~lab-deployment-production-proxy-upstream~1]` in `nginx/production/nginx.conf`;
  `[utest->req~lab-deployment-production-proxy-upstream~1]` in `test_production_nginx.py`, which also pins the
  `resolver_timeout 5s;` line of the TLS server and fails on an in-memory copy without it; the runbook checks the
  gateway and nginx logs before `$DC restart nginx` (R1-SEC-003) and says that a changed `nginx.conf` needs a new
  `NGINX_IMAGE` and `$DC up -d` (R1-REV-002); the `compose.yaml` comment and the m09 tasks lines to match. Checks 3,
  4 and 2.
- [ ] R1.3 Check 1 (G1), once registered, on the head with R1.1 and R1.2. The trace (G6) shows both tags of the new
  requirement.
- [ ] R1.4 Regenerate `frontend/src/content/changelog.generated.json` with `python3 tools/generate_changelog.py`. The
  file is outside this change's files: the coordinator regenerates it after the change `optimistic-concurrency` has
  merged.

## S2. `prod` profile (F4) and non-root engines (F7): blocked on CRP-M09-2

Owner decision CRP-M09-2 (`m09-compose-only`, design.md §4 and §10): keep the production definition standalone and
remove the `prod` profile, or turn production into an override of `docker-compose.yml`. Nothing in S2 starts before
the answer is recorded. S2 keeps only F4 and F7.

Owned (planned): `docker-compose.yml`, `README.md:118-131`, the comment of `.github/workflows/ci.yml:404-411` if
the `prod` profile goes (a workflow edit, so it also needs CRP-M09-3), `deploy/compose/production/compose.yaml`
(`user` and `cap_drop` for the Java engines, `nginx` and `frontend-assets`), `docs/runbooks/production.md` (the F7
bullet of "What stays blocked"), `openbinding-gateway/tests/test_compose_production.py` (F4 and F7 only), and the F4
and F7 lines of `m09-compose-only/tasks.md`.

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
  requirement that a static test can check (design.md D6): the three renders with `--quiet`, `--profile dev`, `--profile "*"` on
  the lab and production renders (design.md D6), the two production env files, the `compose.lab*.json` glob, the `ci-required` entry, and no change-detection gate. It also
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

## A. Archive (explicit archive task, after S1, S1b, R1 and S3, and after the archive of m09-compose-only)

- [ ] `["openspec","archive","m0-infra-close","--yes"]`, then `["openspec","validate","--all","--strict"]`. The
  archive waits for S3, because the `Evidence:` files of `req~lab-deployment-compose-config-in-ci~1` are built there.
  It also waits for the archive of `m09-compose-only`, whose deltas this change builds on
  (`req~lab-deployment-production-health-restart~1` among them). If CRP-M09-3 is never answered, the archive task
  records that and leaves the change open.

## Follow-ups outside this change

- Carry the F5 edit of `bim-toolchain/docs/SERVICE.md` to `isa-group/bim-toolchain` (design.md §4, R4).
- The D1 and D2 behaviour for both configs, `frontend/nginx.lab.conf` and `nginx/local/nginx.conf`. They still
  resolve the gateway once and pass the normalised `/api/` URI through a prefix-replacing `proxy_pass`, so a lab
  preview does not show the production behaviour (design.md §4, R6).
- After the pre-deployment check (1b.7) passes, decide whether a revision
  `req~lab-deployment-production-health-restart~2` drops `restart: true` for `nginx` on `gateway`: each recreation
  of the gateway restarts the whole public origin (design.md §6, Q2).
- If step 7 of the pre-deployment check ever reaches another host, a network alias under a reserved suffix (for example
  `gateway.openbinding.invalid`) used in `set $gateway_upstream` (design.md §3).
- `m09-compose-only` F2, F3, F6 and F8 stay with that change and the owner.
