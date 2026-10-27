# Pricing profile (remote SPACE) for the laboratory

## Purpose

`compose.lab-pricing.json` is an optional laboratory profile: a standalone compose project, `openbinding-lab-pricing`,
with one one-shot service, `pricing-bootstrap`. With a MANAGEMENT key of the remote SPACE, `https://space.score.us.es`,
it creates the `openbinding` service linked to the public SPHERE pricing if it is missing, and the contracts of the
synthetic users. No SPACE and no SPHERE run locally: the profile holds no database, no volume, no network and publishes
no port.

It is not part of the 4032 MiB `compose.lab.json` sum (see [../DEMO.md](../DEMO.md)). The develop lab (4032 MiB), one
preview (4032 MiB) and this profile fit in 9216 MiB (4032 + 4032 + 96 = 8160 MiB).

The manifest carries no `cap_drop`, `read_only` or `security_opt`: the lab supervisor drops capabilities. Nothing here
was built or run live; live evidence is a later slice.

## Variables

The manifest holds one bare reference, with no value and no default.

- `DEMO_SPACE_MANAGEMENT_KEY`: a MANAGEMENT api key of the remote SPACE. The supervisor supplies it from a root-only
  secret file outside the repository. It never appears in the repository, in an image, in a log or in the browser. It must
  be set and non-empty before bring-up: Compose turns an unset variable into an empty string, and the tool then refuses to
  run without a key.

The reference fills `SPACE_API_KEY` of the container. The manifest sets `SPACE_URL` to `https://space.score.us.es`. The
tool reads these variables:

- `SPACE_URL`: base URL of SPACE (an `https` URL with a host and no credentials in the profile).
- `SPACE_API_KEY`: the MANAGEMENT key, filled from `DEMO_SPACE_MANAGEMENT_KEY` by Compose.
- `SPACE_BOOTSTRAP_PLAN`: the plan of every contract (default `FREE`). It is not set in the manifest, so `FREE` applies.

The key is held in process memory only and is never written, logged or printed.

## Memory

Memory sum: 96 MiB

`pricing-bootstrap` has `mem_limit` 96 MiB. Two lab stacks of 4032 MiB plus the profile are 8160 of 9216 MiB.

## Procedure

```
lab_compose up file=compose.lab-pricing.json
lab_compose logs file=compose.lab-pricing.json
lab_compose down file=compose.lab-pricing.json
```

Bring-up builds the image (see the next section) and runs `pricing-bootstrap` once; it has `restart: "no"`. A one-shot
with unchanged configuration may not run again under `up`: use `down` then `up`, or `run --rm pricing-bootstrap`
(UNVERIFIED). The tool is idempotent by lookup before each create. It reports one JSON line.

## Build of pricing-bootstrap

The manifest builds `openbinding-lab/pricing-bootstrap:1` with context `lab/tools` and `Dockerfile` (the repository root
is not used because its `.dockerignore` excludes `lab/`). The tool is `lab/tools/space_lab_bootstrap.py`.

Base image, UNVERIFIED. The digest comes from a Docker Hub lookup of 24-10-2026 (medium confidence); no image was built or
pulled from it. A wrong digest fails the build loudly.

- `python:3.12.8-slim-bookworm` (`lab/tools/Dockerfile`), digest `sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0`, UNVERIFIED.

To confirm after the first build, with `docker inspect`: the image user is `1000:1000`, matching the `user` of the
manifest; and the container environment holds no `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` injected outside the manifest
(for example by the Docker CLI config `proxies`), checked with
`docker compose -f compose.lab-pricing.json run --rm --entrypoint sh pricing-bootstrap -c 'env | cut -d= -f1'`, which
prints variable names only, never values.

Nothing here was built by the author of this document.

## Known advisories

The only image of the profile is built from the `python:3.12.8-slim-bookworm` base, which predates later patch releases
with published advisories (medium confidence, secondary sources). It is a lab-only risk: the container publishes no port,
runs as a non-root user and holds no data. The follow-up moves the base to a maintained tag by verified digest; accepting
this risk meanwhile is the owner's decision.

Supply chain, deferred: the tool requirements carry no hashes. The follow-up generates `--require-hashes` from
`openbinding-gateway/uv.lock` and, once the closure is complete, adds `pip --only-binary=:all:` and `--no-deps`.
