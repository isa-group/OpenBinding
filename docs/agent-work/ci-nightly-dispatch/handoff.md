Goal: S2 of P-20261025-1, nightly.yml dispatching ci.yml on develop.
State: task c1f7be533a924239 integrated; checks green (7 new tests, 25 gate-tooling, 547 full lab/tests; red-before seen). Head 9ba9e51f.
Decisions: GH_REPO: ${{ github.repository }} added to the step env beyond the brief (env was GH_TOKEN only), because without a checkout gh finds no repository and would fail every night; run line and permissions unchanged. The coordinator should be told in the PR body. Earlier attempt b9df8471 failed because registered argv ran at the repo root; fixed with sh -c cd openbinding-gateway.
Ruled out: editing ci.yml, SHA pinning, a checkout step.
Open: openspec validate --strict was not run (no CLI for the worker); the panel's spec check or CI openspec job should cover it. First proof GitHub accepts nightly.yml is the PR CI run (it is not triggered by it, schedule only) and the first scheduled run after the release to main.
Risks: high by path (.github/**); nightly fires only after nightly.yml reaches main through the owner's release PR.
Next: push, open PR, panel on the pushed head, ready.
