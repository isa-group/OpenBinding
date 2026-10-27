# Proposal: m4-remote-space

## Why

ROADMAP M4 ("Plans: SPHERE remote, SPACE local then remote") and INTENT D5 planned a local SPACE 1.7.1 in each stack
"until `space.score.us.es` runs the latest release", followed by a configuration switch (M4.6). The owner request of
this change is that switch, made now and everywhere: **OpenBinding uses the remote SPACE `https://space.score.us.es`
in every environment, and no manifest defines a local SPACE.** Constitution 16.6 already foresees it ("until the owner
switches them to `space.score.us.es` (INTENT D5), they run their own pinned SPACE"); ADR-0015 §1 (the `openbinding`
service linked to the SPHERE permanent link with `all_last`) and ADR-0022 (the 16.1 exception for `lab/tools`) stay.

The local profile was never run live (`docs/qa/PRICING_PROFILE.md`: "Nothing here was built or run live"). Its open
points (shared network `lab-pricing-net`, key volume, image build of SPACE from a pinned commit, old `node:21.1` base
images, Redis and MongoDB advisories, 1088 MiB of lab memory) disappear with it.

## What Changes

- `compose.lab-pricing.json` keeps only the one-shot `pricing-bootstrap` (built from `lab/tools`, 96 MiB, no port, no
  volume, no `depends_on`), whose environment is exactly `SPACE_URL=https://space.score.us.es` and
  `SPACE_API_KEY=${DEMO_SPACE_MANAGEMENT_KEY}`. `space-mongo`, `space-redis`, `space-api`, the `lab-pricing-*` volumes
  and the `lab/space` image build are removed.
- `req~lab-deployment-no-local-space~4`: no manifest, `compose.lab-pricing.json` included, defines a SPACE or SPHERE
  service, network, volume, profile or the retired destructive key.
- `lab/tools/space_lab_bootstrap.py` works against the remote SPACE with a MANAGEMENT api key supplied by the
  supervisor: no admin login, no organization, no api-key creation. It creates the `openbinding` service from the
  SPHERE permanent link if it is missing, awaits its synchronization and creates the contracts of the six synthetic
  seed users.
- The key stays out of the repository, the image, the output and the logs; https only, no redirects, no proxies.
- `docs/runbooks/production.md`: the "Local SPACE (owner decision local-space)" section becomes "Remote SPACE".
- Documentation (ARCHITECTURE, ACCOUNTS_AND_PLANS, DEMO, `openspec/project.md`, `.env.example`, `docs/pricing`) follows.

## Impact

- Capability: `lab-deployment` only (delta `specs/lab-deployment/spec.md`). One MODIFIED requirement of the living spec
  (`No local SPACE`, revision 1 to 4) and four ADDED requirements.
- Superseded unarchived changes: `m41-space-lab-profile`, `m45-lab-pricing-wiring` and the bootstrap and image
  requirements of `m41-space-bootstrap` (design.md §4 lists every retired id). `req~lab-space-no-direct-http~1` of
  `m41-space-bootstrap` is not retired.
- Code and files: `compose.lab-pricing.json`, `lab/space/**` (deleted), `lab/tools/space_lab_bootstrap.py`,
  `docs/qa/PRICING_PROFILE.md`, `docs/runbooks/production.md`, the tests `lab/tests/test_lab_pricing_profile.py`,
  `lab/tests/test_space_lab_bootstrap.py`, `lab/tests/test_no_direct_space_http.py`,
  `openbinding-gateway/tests/test_no_local_space.py`, `openbinding-gateway/tests/test_compose_production.py`, and the
  documents of tasks.md T5.
- No public API, schema or gateway code change. No migration: the local profile holds no data that was ever used.
- Risks (design.md §5): synthetic contracts are written to a SPACE shared with other users of `space.score.us.es`;
  the remote SPACE version and its HTTP routes are UNVERIFIED until the first live run; the lab needs outbound HTTPS to
  `space.score.us.es`.

## Out of scope

- Editing `ROADMAP.md`, `INTENT.md`, `constitution.md` or `docs/adr/**`: the proposed wording is in
  `docs/agent-work/m4-remote-space/roadmap-m4.md`, for the owner.
- Wiring the lab gateways and the previews to the remote SPACE with plans enabled (ROADMAP M4.5) and the gateway
  `plans` module (M4.2); the `DEMO_SPACE_*` variables of `compose.lab.json` are unchanged.
- The seed's own SPACE contract path (`openbinding-gateway/tools/seed_lab.py --space-contracts`).
- Deleting the synthetic contracts from the remote SPACE.
- The factory support for `lab_compose file=compose.lab-pricing.json` (follow-up F1 of `m45-lab-pricing-wiring`).
