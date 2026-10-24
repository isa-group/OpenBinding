GOAL: PR previews per PR head in the NiPoGi lab (ROADMAP M0.5), repo side. PR 30 = the spec slice.
STATE: round 1 answered (686a44ad); round 2 panel at 4e496b8: test-reviewer 36e39394 approve (0 major, 8 minor, 2 nit), reviewer c64cd0b5 changes-requested (1 major port-range vs collision release, 3 minor, 3 nit). All fixed by specifier 42a1e854 (none disputed), integrated at d15a4ea. Line counts: spec 321, design 315, tasks 172.
DECISIONS: G1 NOT EXECUTED (owner decision 24-10-2026, in PR body). Slice order S1b+S3, S1a+S2 (after F1), F2, S4. Changelog commit is added by the coordinator last; nothing pushed after that. Round 3 is one narrow confirmation review (protocol says escalate after two failed rounds; the only open major was a wording contradiction) - state it in lead_ready.
OPEN: ARCHITECTURE section 10 retention row followup; lab/ missing from G6 trace paths; auto-stop of idle previews.
NEXT: (1) push d15a4ea + confirmation reviewer; (2) pr_ready, set_review_package, lead_ready; (3) after merge slices S1b+S3, S1a+S2, F2 (coordinator), S4.
EVIDENCE: tasks 686a44ad, 42a1e854; panels c64cd0b5, 36e39394.
