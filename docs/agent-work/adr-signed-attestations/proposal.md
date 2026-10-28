Status: PROPOSED for owner decision (2026-10-28). Outside the ROADMAP.

# ADR-NNNN: Signed attestations for published evidence and reports

- Status: Proposed (number not assigned; the owner assigns it on acceptance, after ADR-0022)
- Date: 2026-10-28
- Deciders: owner
- Origin: owner request own-65a86ccbc1b84ddca3e9f27f60a0a1be

This is a proposal for a decision request (CRP). It contains no code and changes no behaviour. It is **outside the
ROADMAP**: no milestone in `ROADMAP.md` covers it, so it needs the owner's approval before the coordinator can turn it
into a slice (INTENT §11). M2.6 (Verify page) is in flight and must not wait for it.

## Context

`docs/RESOLVER_AND_VERIFIER.md` (line 10) states that SHA-256 "verifies content equality; it is not an author
signature". Today a third party who holds a report, an evidence file or an artifact can check that some OpenBinding
record has the same content digest, but not that **this OpenBinding instance produced or published it**. The only
witness is the instance's own database and API, so the check is circular: the verifier trusts what it is verifying.

For a platform whose citable results go into papers (INTENT §1, ROADMAP M6.5 published results), a reader should be able
to check, offline and without an account, that a published report really comes from the OpenBinding instance the paper
cites, and that it was not edited afterwards or fabricated with a copied digest.

Reference design (given by the owner): SPACE PR #87, which issues ES256 pricing tokens with a JWKS endpoint, a `kid` per
signature, key rotation with previous keys kept published, ES256 as the only accepted algorithm when verifying, and no
`jwk`/`jku` in the header. I could not read that PR from this worktree; the properties above are taken from the request
and must be confirmed against the PR when this is implemented (open question 9).

### Existing facts this proposal builds on

- Records are located by content digest and `kind`; digests are RFC 8785 canonical JSON SHA-256 or raw file SHA-256
  (`docs/RESOLVER_AND_VERIFIER.md`, kind table). Digests prove equality only.
- The organization library has separate content and version-manifest digests (`docs/VERSIONED_ARTIFACTS.md`).
- Permalinks point to a published, immutable version; a Verify page (M2.6) resolves a digest or a dropped file.
- Private records are visible only to their organization; the resolver returns only "accessible" records.

## Decision drivers

1. A third party can verify without trusting the OpenBinding database or network path.
2. Verification works with a stock JOSE library, with no OpenBinding code.
3. Small scope (ADR-0020): one signature format, one algorithm, one key endpoint.
4. No new secret leak or availability risk: losing the key must not corrupt data, and a signing outage must be visible.
5. Does not change any existing digest, permalink or stored artifact.

## Options

### A. Do nothing; document the limit (status quo)

- Pro: no work, no key to protect.
- Con: the circularity remains; papers cannot cite verifiable provenance beyond "the instance says so".

### B. Sign the artifact digests themselves (detached signature per artifact, stored alongside)

- Pro: each file carries its own proof.
- Con: signs raw content only; no `kind`, organization, date, engine or revision, so a valid signature can be replayed on
  a different context. Many signatures to store and re-sign on rotation policy changes.

### C. Compact JWS attestation per published item, claims bound to context (recommended)

A small JWS (RFC 7515, compact serialization, ES256) whose payload binds the digest to its context. One attestation per
published evidence item or report, created at publication time and stored with the record. Public keys at
`/.well-known/jwks.json`.

- Pro: standard, verifiable with any JOSE library; binds digest, kind, organization and revision, which prevents replay;
  small; matches the SPACE reference design so reasoning and security tests are reused.
- Con: new key custody duty; a rotation procedure; one more startup dependency.

### D. Transparency log or external timestamping (for example a Merkle log, or anchoring to a public service)

- Pro: stronger against a compromised instance key (backdating is detectable).
- Con: infrastructure and an external dependency, against ADR-0020 and ADR-0021. Can be added later on top of C, because
  attestations are already content-addressed.

### E. Sign with an organizational PGP/Sigstore identity instead of an instance key

- Pro: ties to a person or institution.
- Con: a second trust system, heavier tooling, no JWKS-style discovery; the request is about proving the instance, not the
  person.

**Recommendation: C**, with D left as a possible later addition.

## Proposed decisions (for option C)

### 1. What is signed

Options: (i) published items only; (ii) published items plus private runs.

**Recommended: (i) published evidence and reports only.** Published items are public, immutable and meant to be cited,
and a signature on them leaks nothing. Signing private runs would put an organization, a digest and a date into a
signature that the holder can hand to others, and it adds volume and a signing load on every run. A private item gets its
attestation at the moment it is published (M6.5), not before. If the owner wants private-run attestations later, they are
issued on demand to the authenticated owner of the run, never published, and need their own decision.

Items covered: kinds `report` and `artifact` already published, and the evidence of a published study result; not
engines, dialects or intermediate IR unless they are part of a published result.

### 2. Claims

Header: `alg` = `ES256`, `typ` = `openbinding-attestation+jwt` (or a registered media type if the owner prefers),
`kid` = id of the signing key. No `jwk`, `jku`, `x5u` or `x5c`.

Payload (all required, short names in brackets are the proposed claim names):

| Claim | Meaning |
|---|---|
| `iss` | Canonical base URL of the instance |
| `sub` | Content digest, with algorithm prefix (`sha256:...`), same value the resolver uses |
| `kind` | Resolver kind (`report`, `artifact`, ...) |
| `org` | Organization slug that publishes the item |
| `iat` | Signing date (RFC 7519 NumericDate) |
| `engine` | Engine id and version when the item is a run result; omitted otherwise |
| `rev` | Revision of the item (version or revision identifier of the permalink target) |
| `jti` | Unique attestation id |

Not included: user identity, private titles, problem content, free text. No `exp`: an attestation is a statement about
immutable content and stays valid; key lifetime is handled by rotation and, if needed, revocation (open question 5).
Claim names that clash with registered JWT claims keep their registered meaning; the rest are private and documented in
the OpenAPI document and in `docs/RESOLVER_AND_VERIFIER.md`.

### 3. Key custody and rotation

- Algorithm: ES256 (P-256) only. The verifier accepts only `ES256`, rejects `none`, rejects any `alg` not in its list,
  ignores or rejects `jwk`, `jku`, `x5u`, `x5c` in the header, and selects the key only by `kid` from its own key set.
- Private key: supplied by configuration (an environment value) or a secrets file path mounted by Docker Compose
  (ADR-0021). Never stored in the database, never logged, never in the repository, never in an image layer.
- Startup: outside development the server **does not start** without a valid signing key. In development a key is
  generated in memory and each start announces that attestations are not durable.
- Public keys: `/.well-known/jwks.json`, unauthenticated, `Cache-Control` with a bounded `max-age` (proposed 1 hour) and
  an `ETag`. It lists the active key and every previous key that signed any stored attestation.
- Rotation: add the new key, start signing with it, **keep the old public key published** so earlier signatures verify.
  A key is removed from the JWKS only on compromise, as a revocation (open question 5). Each key has a `kid` derived from
  its public-key thumbprint (RFC 7638) so ids cannot collide or be chosen by an attacker.
- Cadence: rotation on demand or yearly (open question 4); the procedure is a runbook, not an automatic job.
- Loss of the private key: past attestations still verify (public keys stay); new ones need a new key. This is why
  previous public keys must also be backed up with the instance data.

### 4. Relation to existing digests and permalinks

- Digests do not change. The attestation **refers to** the existing content digest in `sub`; nothing is re-hashed and
  no stored artifact is rewritten. The resolver and its kinds are unchanged.
- Permalinks do not change. The attestation is an additional field/endpoint of the permalink target: the published
  result links to its attestation, and the citation panel can offer it (M2.7 `CitationPanel`).
- Verify page (M2.6): given a digest, file or attestation, it checks the digest as today and **also** verifies the JWS
  signature against the instance's JWKS (or one the user pastes, for a different instance), then shows "content matches"
  and "signed by this instance on <date>" as two separate results. A digest match without an attestation is shown as
  "content equality only", as now.
- Outside OpenBinding: anyone can fetch the compact JWS and `/.well-known/jwks.json` and verify with a JOSE library
  (for example `jose` in JavaScript or `python-jose`/`authlib` in Python), then compare `sub` with the SHA-256 of the
  file. The documentation will show this in a short example.
- The documented limit changes from "not an author signature" to "SHA-256 proves content; a signed attestation proves
  this instance published it; neither proves scientific correctness".

### 5. Security reasoning and tests (reusing SPACE PR #87)

Reuse the reasoning and the test cases, adapted: accept only ES256; reject `alg: none`, HS256 (key-confusion), a token
whose `kid` is unknown, a header with `jwk` or `jku`, a payload altered after signing, a signature from another key with
the right `kid`, an empty or oversized token; rotation test (a token signed before rotation verifies after it); startup
test (missing key outside development fails); JWKS test (no private parameters `d` in any key, cache headers present,
no authentication needed). Also a replay test specific to this design: an attestation does not verify for another
digest, kind or organization when the verifier compares them with the item it is shown.

## Consequences

Positive
- Third parties can check origin without trusting the database; this supports papers and M6.5 published results.
- Standard format, no new client library for verifiers, no changes to digests or permalinks.
- Reuses an already designed pattern with an existing test set.

Negative and risks
- A new secret to custody; mistakes in custody or rotation harm trust more than having no signature.
- The instance key is a single point: a stolen key lets an attacker sign false claims for that instance until rotation and
  revocation. A transparency log (option D) would mitigate this and is deferred.
- The server refuses to start without a key outside development: a deployment mistake becomes an outage (intended).
- JWKS growth is small but unbounded; previous keys cannot be dropped without breaking earlier verification.
- Signing adds work on publication; it is bounded (one signature per publication) and must not block reads.
- It does not prove that the results are correct or reproducible, only provenance; the Verify page must not imply more.

Scope and process
- Touches the OpenAPI document (new `/.well-known/jwks.json` and an attestation field), so it needs the contract-first
  process (ADR-0013) and the committed snapshot update.
- Touches the Verify page (M2.6) and the citation panel (M2.7): both can ship first without attestations and add them
  after, so the ordering carries no blocker.
- Rough size, to be confirmed when sliced: key loading and signing module, JWKS endpoint, attestation storage and
  creation at publish, verification in the Verify page, docs. Likely 3 to 4 slices.

## Open questions for the owner

1. Approve the idea at all, given it is outside the ROADMAP? If yes, as which milestone (suggested: after M6.5, because
   it needs published results to exist; a first slice limited to reports could precede it).
2. Scope of signing: published only (recommended) or also private runs on demand?
3. Are the proposed claims right? In particular: include `engine`, `rev`, and `jti`; `sub` as `sha256:<hex>` with prefix?
4. Rotation cadence: on demand only, or a yearly rule? Who holds the key operationally (owner or the lab), and where is
   it backed up?
5. Revocation: is removing a compromised key from the JWKS (which invalidates all its attestations) acceptable, or should
   a signed revocation list exist? Proposed: removal only, documented.
6. Should historical publications (existing published results) be attested retroactively? Their "signing date" would be
   the backfill date, not the publication date; proposed: yes, marked with a `backfill` claim, or no, only new
   publications.
7. Should the instance also be able to verify attestations from another OpenBinding instance (paste a JWKS URL)? Proposed:
   the Verify page accepts a pasted JWKS or token, but never fetches a URL given by a user, to avoid server-side request
   forgery.
8. Do we want option D (transparency log or timestamping) later? Decide now only whether to keep the door open.
9. Confirm that the reference properties of SPACE PR #87 (ES256 only, `kid`, no `jwk`/`jku`, rotation) are as described
   and share the test files to reuse, since they could not be read from this repository.
10. Media type or `typ` value for the attestation, and whether to publish the attestation format as a short spec under
    `docs/`.

## Evidence

- `docs/RESOLVER_AND_VERIFIER.md` line 10 (SHA-256 is not an author signature) and the kind table.
- `docs/VERSIONED_ARTIFACTS.md` (content and version-manifest digests).
- `ROADMAP.md` M2.6, M2.7 and M6.5 (Verify page, citation panel, published results).
- ADR-0013 (committed OpenAPI snapshot), ADR-0020 (smaller platform), ADR-0021 (Docker Compose only).
- RFC 7515 (JWS), RFC 7517 (JWK), RFC 7518 (ES256), RFC 7638 (thumbprint), RFC 8785 (canonical JSON).
- SPACE PR #87, as described by the owner; not read.
