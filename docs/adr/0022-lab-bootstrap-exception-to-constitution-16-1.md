Status: PROPOSED (2026-10-24)

# ADR-0022: Lab bootstrap exception to constitution 16.1

- Status: Proposed; the owner approved the exception on 2026-10-24 (answer own-36b6e089)
- Date: 2026-10-24
- Deciders: owner

## Context

Constitution 16.1 says SPACE is reached only through its official clients and that no module calls SPACE's HTTP API
directly; ADR-0015 §2 says the gateway's plans module is the only code that talks to SPACE, through
`space-python-client`. The lab `pricing` profile (ROADMAP M4.1, ARCHITECTURE §9.4) needs a one-shot bootstrap that
creates an organization, a `MANAGEMENT` api key and the `openbinding` service from the SPHERE permanent link in a fresh
SPACE 1.7.1. `space-python-client` 1.0.0 covers contracts, features and health, with no organization, api-key, user or
service operation, so the bootstrap cannot be written with the client alone.

## Decision

1. The exception to 16.1 applies only to `lab/tools/**` (the bootstrap `lab/tools/space_lab_bootstrap.py`); it may call
   SPACE's HTTP API with httpx for the operations the client lacks.
2. The tool uses `space-python-client` wherever it covers the operation (contracts, features, health).
3. The constitution is not edited; this ADR is the record of the exception.
4. An architecture test (`lab/tests/test_no_direct_space_http.py`, `req~lab-space-no-direct-http~1`) forbids direct
   HTTP to SPACE or SPHERE outside `lab/tools/**` and the gateway plans module. The allow-list is at directory level,
   but a test pins `lab/tools/space_lab_bootstrap.py` as the only direct caller under `lab/tools`.
5. The tool holds no SPHERE key and sends nothing to SPHERE; SPACE reads the public link itself (constitution 16.2).

## Consequences

- Two pre-existing deviations are pinned by the test: `openbinding-gateway/tools/_remote_common.py` (its `SpaceRemote`
  uses httpx for services and its `SphereRemote` calls SPHERE; a development probe outside `lab/tools`) and
  `openbinding-gateway/src/openbinding_gateway/sphere_client.py` (direct SPHERE client, removed by ADR-0015 §7). A pin
  fails once it is no longer needed; moving or retiring them is a follow-up.
- Any new direct caller outside the allowed paths fails the unit suite.
- The exception is revisited when `space-python-client` covers organizations, api keys and services: the tool then
  moves to the client and this ADR is superseded.
- The SPACE HTTP sequence is unverified against a live 1.7.1 until the lab runs the profile (slice S5 of
  `m41-space-lab-profile`).

## Evidence

- `constitution.md` Article 16 (16.1, 16.2); ADR-0015 §2 and §5; `docs/ARCHITECTURE.md` §9.4; `ROADMAP.md` M4.1
- `openspec/changes/m41-space-bootstrap/` (design.md §4 and §6); `openspec/changes/m41-space-lab-profile/design.md` §8
- Architecture test `lab/tests/test_no_direct_space_http.py`: `test_no_direct_http_to_space_or_sphere_outside_the_allowed_paths`,
  `test_known_deviations_are_pinned_and_still_needed`, `test_the_lab_tools_exception_is_recorded_in_the_adr`,
  `test_lab_tools_has_only_the_bootstrap_as_a_direct_caller`, `test_control_detects_a_direct_call`,
  `test_control_detects_more_clients_and_aliases`, `test_control_skips_tests_and_mocks`
- Owner answers own-36b6e089, own-78031d63 (build-pinned-exception) and own-e95fb0a1 (approve-m41)
