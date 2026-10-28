# Proposed ROADMAP M4 wording: remote SPACE (change m4-remote-space)

Status: PROPOSED for owner review (2026-10-27). `ROADMAP.md`, `INTENT.md`, `constitution.md` and `docs/adr/**` are
the owner's documents and are not edited by the change `m4-remote-space`; this file gives the before/after wording
for the owner to apply or amend. Rows not listed (M4.0, M4.3, M4.4) are unchanged.

## 1. ROADMAP.md

### Milestone table (row M4)

Before:

> | M4 | Plans: SPHERE remote, SPACE local then remote | M0; pricing 0.2.0 published | the pricing-change scenario of M4 | R2 | in progress (M4.0 done; M4.1 partly, PR #36) |

After:

> | M4 | Plans: SPHERE and SPACE remote | M0; pricing 0.2.0 published | the pricing-change scenario of M4 | R2 | in progress (M4.0 done; M4.1 being redone for the remote SPACE, change `m4-remote-space`) |

### Heading and goal

Before:

> ## M4 — Plans: SPHERE remote, SPACE local then remote
>
> Goal: OpenBinding behaves like the TomatoMeter host application: its pricing lives in SPHERE at `sphere.score.us.es`,
> SPACE operates it, and OpenBinding adapts without redeploying. SPACE runs locally in each stack until
> `space.score.us.es` runs the latest release (INTENT D5).

After:

> ## M4 — Plans: SPHERE and SPACE remote
>
> Goal: OpenBinding behaves like the TomatoMeter host application: its pricing lives in SPHERE at `sphere.score.us.es`,
> SPACE at `space.score.us.es` operates it, and OpenBinding adapts without redeploying. No stack runs a local SPACE
> or SPHERE (INTENT D5).

### M4.1

Before:

> | M4.1 | Lab `pricing` profile: a pinned SPACE 1.7.1 (`space-api`, MongoDB, Redis), `pricing-bootstrap` that creates the `openbinding` service from `https://sphere.score.us.es/p/6ab0a323697330667ccce891` (`all_last`) and contracts for the synthetic users; no local SPHERE; `tests/test_no_local_space.py` narrowed (ADR-0015) | `labctl`/`lab_compose` brings it up; SPACE shows the service `ready` on the latest public version; the lab reaches `sphere.score.us.es` over HTTPS |

After:

> | M4.1 | Lab bootstrap against the remote SPACE: the optional project `compose.lab-pricing.json` with the one-shot `pricing-bootstrap` only (96 MiB), authenticated by a MANAGEMENT key that the supervisor injects as `DEMO_SPACE_MANAGEMENT_KEY`; it creates the `openbinding` service from `https://sphere.score.us.es/p/6ab0a323697330667ccce891` (`all_last`) if missing and the contracts of the six synthetic seed users; no local SPACE or SPHERE in any manifest (`tests/test_no_local_space.py`, ADR-0015, ADR-0022) | `lab_compose` runs it once; `space.score.us.es` shows the service `ready` on the latest public version and the six contracts; a second run creates nothing; the lab reaches `space.score.us.es` over HTTPS |

### M4.2 (acceptance only)

Before:

> | M4.2 | ... | contract tests against the lab profile; fail-closed when SPACE is down |

After:

> | M4.2 | ... (deliverable unchanged) | contract tests against the remote SPACE with the lab key, skipped without it; fail-closed when SPACE is down |

### M4.5

Before:

> | M4.5 | Lab and previews run with the local SPACE by default | seed users have contracts; previews show real plans |

After:

> | M4.5 | Lab and previews run with plans enabled against the remote SPACE by default (`DEMO_SPACE_ENABLED=true`, the lab MANAGEMENT key supplied by the supervisor) | seed users have contracts (M4.1); previews show real plans |

### M4.6

Before:

> | M4.6 | Switch to `space.score.us.es` once it runs the latest SPACE release (owner decision, configuration only) | previews and production use it; the local profile is off |

After (the switch is made by M4.1; what is left is production):

> | M4.6 | Production on the remote SPACE: `SPACE_URL=https://space.score.us.es` and the `space_api_key` secret file, documented in the "Remote SPACE" section of `docs/runbooks/production.md` (no local SPACE) | the production pre-flight accepts the https URL; the gateway starts with plans enabled; the runbook test passes |

### Slice status paragraph

Before (end of the paragraph):

> M4.1 partly merged (PR #36: optional pricing profile, static tests, narrowed no-local-space test); the other slices
> have no recorded progress.

After:

> M4.1 redone for the remote SPACE by the change `m4-remote-space` (the local profile of PR #36 was never run live and
> is removed); the other slices have no recorded progress.

### Acceptance scenario

Before:

> ... the stack's SPACE migrates the contracts within its synchronization cycle (five minutes, or "Synchronize now") ...

After:

> ... the remote SPACE migrates the contracts within its synchronization cycle (five minutes, or "Synchronize now") ...

## 2. Proposed ADR amendments (not applied)

### ADR-0015 (plans through SPACE and SPHERE clients)

- Decision §5, Topology. Replace "Until `space.score.us.es` runs the latest SPACE release (1.7.1 today), each stack
  runs its own pinned SPACE of that release, whose `openbinding` service is created from that permanent link
  (`source: sphere`, `all_last`) by a bootstrap. Switching to `space.score.us.es` is a change of configuration." with:
  "Every environment uses the remote SPACE at `space.score.us.es`; no stack runs a local SPACE. Its `openbinding`
  service is created from that permanent link (`source: sphere`, `all_last`) by the lab bootstrap if it is missing."
- Consequences, first bullet. Replace "a pinned SPACE image is allowed in the lab and the previews;
  `tests/test_no_local_space.py` is narrowed accordingly" with: "no manifest defines a SPACE or SPHERE service
  (`req~lab-deployment-no-local-space~4`, `tests/test_no_local_space.py`)".
- Consequences, second bullet. Add: "the stacks also need outbound HTTPS to `space.score.us.es`; plans fail closed
  when it is down."
- Consequences, last bullet. "Client and image upgrades" becomes "Client upgrades"; the SPACE release is the one that
  SCORE Lab runs at `space.score.us.es`.
- Status line. Record the date and the owner request of the switch.

### ADR-0022 (lab bootstrap exception to constitution 16.1)

- Context. Replace "creates an organization, a `MANAGEMENT` api key and the `openbinding` service from the SPHERE
  permanent link in a fresh SPACE 1.7.1" with: "creates, in the remote SPACE `space.score.us.es`, the `openbinding`
  service from the SPHERE permanent link if it is missing, and the contracts of the six synthetic seed users".
- Decision, new item: "The tool authenticates only with a `MANAGEMENT` api key, supplied by the supervisor as
  `DEMO_SPACE_MANAGEMENT_KEY` and given to the tool as `SPACE_API_KEY`; it has no admin login and creates no
  organization and no api key. It accepts only an `https` `SPACE_URL`."
- Decision §1 to §5 stay (the exception is still limited to `lab/tools/**` and the bootstrap).
- Context, last sentence: the operations the client lacks are now services, synchronization and pricings (no longer
  organizations and api keys).
- Consequences, last bullet. Replace "unverified against a live 1.7.1 until the lab runs the profile (slice S5 of
  `m41-space-lab-profile`)" with "unverified against `space.score.us.es` until the first live run of the bootstrap
  (change `m4-remote-space`, design.md §6)".
- Evidence: add `openspec/changes/m4-remote-space/`; the `m41-*` changes are superseded for the bootstrap.

## 3. Other owner documents with the same conflict (not applied)

- `INTENT.md` §8, third non-goal: drop "Until `space.score.us.es` runs the latest SPACE release, the lab and previews
  run a local SPACE of that release, linked to the pricing in `sphere.score.us.es` (ADR-0015)."; keep "Hosting SPHERE
  or SPACE in production" as a non-goal.
- `INTENT.md` §12, D5: "SPHERE at `sphere.score.us.es` and SPACE at `space.score.us.es` everywhere; no local SPACE".
- `constitution.md` 16.6, last sentence: "until the owner switches them to `space.score.us.es` (INTENT D5), they run
  their own pinned SPACE" becomes "they use the SPACE at `space.score.us.es`".
- `constitution.md` 16.4: "contract tests against the pinned images in the lab" becomes "contract tests against the
  remote SPACE in the lab".
