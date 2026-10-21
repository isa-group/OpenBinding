Status: DRAFT for owner review (2026-10-21)

# ADR-0007: Pin the MiniZinc solver to an official bundle verified by checksum

- Status: Accepted
- Date: 2026-10-21 (recorded; decided in the owner's QACOBench 1.1.1 release, commit 014e43a; integrated in 912648c)
- Deciders: owner

## Context and problem

Exact-solver results and run times are part of published experiments. The distribution package (`apt install
minizinc`, 2.6.4 before the integration) changes with the base image and is not recorded per campaign.

## Decision

The `minizinc-csp` image installs the official MiniZinc bundle (MiniZinc 2.8.7 + Gecode 6.3.0) from the MiniZincIDE
release, verifies its SHA-256, strips unused solvers, self-tests, and every QACOBench run manifest records
`minizinc --version` and the solver list.

## Consequences

- Upgrading the bundle is a CRP-level change: it can change QACOBench reference results (`INTENT.md` §8).
- The integration kept the bundle and added tini as PID 1, an unprivileged scratch directory and lab/production stages.
  The runner now runs flattening, `fzn-gecode` and `.ozn` rendering as separate process groups (`MINIZINC_COMMAND`,
  `FZN_GECODE`).

## Evidence

`engines/minizinc-csp/Dockerfile` (ARG `MINIZINC_VERSION=2.8.7`, `MINIZINC_SHA256`);
`experimentation/qacobench/reference/1.1.1/minizinc_versions.txt`.
