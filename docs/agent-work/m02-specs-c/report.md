# M0.2 — requirement length (specs C)

Rule: body of each `### Requirement:` (EARS sentence + id line + Evidence line) at most 500 characters, target 450.
No openspec binary was available: lengths are hand counts (error about ±15 characters), not tool output. Run
`openspec validate --strict --all` to confirm.

Revision rule (constitution 1.3): a requirement whose meaning changes bumps its revision; pure rewording and evidence
trimming do not. Splits narrow the old id (bump) and add new ids at `~1`.

No code or test carries a tag for any of these ids (grep `req~<capability>-` outside the five specs: no matches), so
nothing needs retagging.

| Requirement | Before | After | Id before | Id after |
|---|---|---|---|---|
| Private projects indistinguishable | ~486 | ~455 | private-indistinguishable~1 | same (reworded) |
| Public read GET-only | ~536 | ~435 | public-read-matrix~1 | same (reworded; source-file evidence dropped) |
| Visitors see only published material | ~607 | ~335 | visitor-filtering~1 | visitor-filtering~2 (reports and publications only) |
| (new) public files and library artifacts | — | ~415 | — | visitor-files-library~1 |
| Public read rate limit | ~516 | ~447 | public-read-rate~1 | same (source-file evidence dropped) |
| Exact references in composition | ~471 | ~447 | exact-composition~1 | same (reworded) |
| Live pricing document | ~646 | ~420 | live-document~1 | live-document~2 (drops release labels) |
| (new) release labels | — | ~335 | — | release-labels~1 |
| Pricing changes need no code change | ~564 | ~430 | document-driven~1 | document-driven~2 (drops mapping layer) |
| (new) no mapping layer | — | ~265 | — | no-mapping-layer~1 |
| Read-only pricing source | ~525 | ~420 | read-only-source~1 | same (one evidence entry dropped) |
| Declared exact-weighted subset | ~495 | ~440 | declared-subset~1 | same (reworded; README evidence dropped) |
| Supported constructs of 1.1.1 | ~640 | ~415 | supported-constructs~1 | supported-constructs~2 (structures, aggregations) |
| (new) supported constraints and placement | — | ~410 | — | supported-constraints~1 |
| Solver process containment | ~437 | ~430 | process-containment~1 | same (reworded) |
| Resolution without leakage | ~524 | ~446 | no-leakage~1 | same (reworded; docs evidence dropped) |
| Verifier account and visibility | ~700 | — | inspect-visibility~1 | split into the three below |
| (new) verifier requires an account | — | ~230 | — | inspect-auth~1 |
| Verifier filters by visibility | — | ~290 | inspect-visibility~1 | inspect-visibility~2 |
| (new) hidden elements look unregistered | — | ~330 | — | inspect-indistinguishable~1 |
| Configuration validation | ~620 | ~440 | generator-config-validation~1 | config-validation~2 (size limits moved out) |
| (new) configuration size limits | — | ~250 | — | config-size-limits~1 (Evidence: GAP, no test names the limits) |
| Target engine compatibility hint | ~465 | ~450 | generator-target-engines~1 | same (reworded) |

Requirements not listed were estimated under 450 and left alone (private/sealed/history in collaboration-artifacts,
no-checkout, plan-strip, engine catalogue, status mapping, options, boundary slack, index translation, bounded queue,
pinned solver, digest input, pure function, persist authorization, seeded reproducibility, feasibility witness).

Evidence dropped to fit (behaviour unchanged, entries still exist in the repository): `access/public_read.py`
(collaboration matrix and rate), `test_the_sphere_client_has_no_write_operations` (read-only source),
`engines/minizinc-csp/README.md` (declared subset), `docs/RESOLVER_AND_VERIFIER.md` (no-leakage),
`docs/BIM_GENERATOR.md` (config validation).

Scenarios: all kept. New scenarios were added for the new or split requirements (visitor files, deprecated document,
no mapping layer, parallel/product, anonymous inspection, member inspection, too many features).

Lengths worth rechecking with the tool: private-indistinguishable, public-read-rate, exact-composition,
declared-subset, no-leakage (all hand-counted above 440).
