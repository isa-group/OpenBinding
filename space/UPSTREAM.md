# SPACE 1.5 compatibility audit

OpenBinding pins SPACE `v1.5.0`
(`79aea10c9acff1d85e4931d09aa21d3a253d1ce1`) and
`space-python-client` `1.0.0`. This file records the checks that matter when
either pin changes. It is not a list of local dependency patches: both
dependencies run unmodified.

## Fixed since the former SPACE 1.0 integration

The `v1.5.0` tag contains the upstream fixes OpenBinding previously had to work
around or monitor:

| Behaviour | Evidence in `v1.5.0` |
|---|---|
| Multi-limit expected consumption lost concurrent updates | Contract repository applies one atomic MongoDB update (upstream PR #60). |
| `expectedConsumption: 0` was treated as absent | Zero is accepted explicitly (upstream PR #61). |
| Database outage looked like an authentication failure and health stayed green | Authentication distinguishes lookup failure and `/healthcheck` pings MongoDB (upstream PR #59). |
| Pricing2Yaml 3.1 was rejected | SPACE uses `pricing4ts` `^0.11.1` (upstream PR #58). |

The canonical OpenBinding pricing is parsed in CI with `pricing4ts` `0.11.1`.
Do not infer the deployed SPACE version from its package metadata: upstream's
tagged root and API package versions were not changed for the `v1.5.0` release.

## Contracts that remain intentionally asymmetric

- Feature evaluation uses qualified identifiers such as
  `openbinding-taskStarts`; a contract usage-level update is already nested
  under the service and therefore uses the canonical `taskStarts` identifier.
- A pricing version is immutable once deployed. Availability changes and exact
  archived-version deletion are separate operations.
- `MANAGEMENT` can deploy and archive versions and manage contracts. Deletion
  needs `ALL`, so OpenBinding accepts a separate destructive key and never
  promotes the normal key.
- The Pricing2Yaml validator requires each plan to materialize its feature
  values. The OpenBinding document does so; YAML anchors only remove source
  repetition and are resolved before validation.

## Upgrade checklist

Before changing the pin:

1. Check out the exact candidate tag and record its commit in `VERSION`,
   `prepare.sh`, Compose labels, Kubernetes image and third-party notices.
2. Confirm the API still accepts `x-api-key` organization keys and the
   `MANAGEMENT`/`ALL` split for every route OpenBinding calls.
3. Parse `pricing/openbinding.yml` with the candidate's `pricing4ts` and render
   it with the pinned `pricing-renderer`.
4. Run the `space-python-client` integration suite against the real container:
   create a contract, evaluate, reserve, settle, novate on renewal and preserve
   add-on quantities.
5. Exercise the control-room lifecycle: deploy private preview, publish/deploy
   `0.1.0`, activate LIVE, drain/archive, redeploy and delete only an archived
   private version with the destructive key.
6. Restart the worker and SPACE API mid-job and reconcile usage and abandoned
   work. Verify secrets never appear in logs.
7. Restore a MongoDB backup into an isolated namespace and compare contracts,
   service versions and usage before promoting the image.

An upstream regression should be reported with a minimal reproduction. Keep a
temporary compatibility guard in OpenBinding only when data integrity or
access control would otherwise be wrong, and remove it once the minimum pin
contains the fix.
