# Pricing fixture

Two files stand for what SPHERE's public, keyless API serves for the permanent link
https://sphere.score.us.es/p/6ab0a323697330667ccce891:

- `manifest.json`: `GET https://sphere.score.us.es/api/v1/public/pricings/6ab0a323697330667ccce891`
- `openbinding-0.2.0.yml`: `GET .../pricings/6ab0a323697330667ccce891/versions/6ada6dbd4b2b5b01c587d17f/yaml`

**Both are derived, not recorded live.** The worker that wrote them had no network.
`openbinding-0.2.0.yml` is a byte copy of `docs/pricing/openbinding-0.2.0.yml`;
`manifest.json` was written by hand from the shape in
`openspec/changes/m43-plans-pricing-route/design.md` section 1, with `contentHash` set to the
SHA-256 of that YAML.

The public API needs no key and no cookie. Nothing in this directory needs a credential.

## Shape assumptions (none confirmed against a live response)

- The manifest is `{pricingId, name, permanentUrl, latestVersionId, versions: [...]}` and each
  version is `{versionId, version, createdAt, contentHash}`; `contentHash` is 64 lowercase hex.
- `contentHash` is the SHA-256 of the YAML bytes served for that version.
- `createdAt` is the date `2026-10-22` (the YAML's own `createdAt`); the real service may send a
  full timestamp.
- The YAML endpoint answers the document unchanged, without re-serialising it.

## Digest discrepancy (unresolved)

The SHA-256 of `docs/pricing/openbinding-0.2.0.yml` in this tree is
`4b9c7203c2771991be54c11bddf1fee5fc385c8cc5fa28b21e6d06b37d5b75b1`. `ROADMAP.md` line 133
claims `3db4ad99b33f0a591fcc71167bb7410e10a477429d48a0105afd17bf629b182c`. The coordinator
settles which is right (line endings, a later edit, or the bytes SPHERE serves). Here the file in
the tree is authoritative, so the manifest carries the first digest.

## Tests

`tests/test_space_client_contract.py` checks that the YAML copy is byte-identical to the docs
YAML, that `contentHash` is the SHA-256 of the copy, that `latestVersionId` names an entry of
`versions`, and that the entry's `version` equals the YAML's `version`.

## Re-record from SPHERE (keyless)

    API=https://sphere.score.us.es/api/v1/public/pricings/6ab0a323697330667ccce891
    curl -fsS "$API" -o manifest.json
    curl -fsS "$API/versions/<latestVersionId>/yaml" -o openbinding-<version>.yml

Compare `sha256sum openbinding-<version>.yml` with the manifest's `contentHash`, then settle
the digest discrepancy above and update the shape assumptions and the file names in the test.

## Update after a legitimate edit of the docs YAML

    cp docs/pricing/openbinding-0.2.0.yml openbinding-gateway/tests/fixtures/pricing/
    sha256sum docs/pricing/openbinding-0.2.0.yml

Put the printed digest in `manifest.json` as `contentHash` (and change `version` and the file
name if the edit bumps the version).
