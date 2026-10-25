Goal: ci.yml also runs on push to develop and on workflow_dispatch, with a top-level concurrency block (group ci-event_name-head_ref||ref, cancel-in-progress only for push). Permissions stay contents: read; no job, step, action or timeout change; the pull_request block is byte-identical. The nightly (S2, nightly.yml) is NOT in this change, per the owner's answer push-now-nightly-b.

State: three tasks integrated, head 9d38c527 before this checkpoint commit. Tasks: 104f4925c7b843fd (test; red_before: 4 AssertionError on the base), 528ff5ce11884885 (OpenSpec change; openspec validate --strict NOT run, no G1 evidence from the worker), b582cde808614757 (ci.yml edit; qa_run checks passed: test_ci_triggers 4 passed, test_ci_gate_tooling 25 passed, all of lab/tests 539 passed and 4 skipped).

Decisions: the test is written by an implementer because the test-designer role is limited to acceptance/. The test pins the trigger set to exactly {pull_request, push, workflow_dispatch}, so a schedule in ci.yml fails it (schedule would run main's copy and test main). The test also asserts that no job has a job-level if or its own permissions, because the spec scenarios promise this.

Risks: no registered check validates workflow syntax or openspec validate here. The PR's own CI run is the proof that GitHub accepts the YAML. After the merge, the first push run on develop is the second proof. A superseded develop head gets a cancelled run, not a result.

Next: push chore/ci-develop-push, open the PR, run the high panel on the pushed head, then set_review_package (how_to_review) and lead_ready.
