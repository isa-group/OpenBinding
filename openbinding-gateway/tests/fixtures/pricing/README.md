# Pricing fixture

`sphere_public_pricing_0.2.0.json` stands for the answer of

    GET https://sphere.score.us.es/api/v1/public/pricings/6ab0a323697330667ccce891

(permanent link https://sphere.score.us.es/p/6ab0a323697330667ccce891).

**It is derived, not recorded live.** The worker that wrote it had no network.
The `pricing` object is `docs/pricing/openbinding-0.2.0.yml` (sha256
`4b9c7203c2771991be54c11bddf1fee5fc385c8cc5fa28b21e6d06b37d5b75b1` as committed in
this tree) transcribed to JSON by hand; `test_space_client_contract.py` compares
both and checks the digest of the YAML file. The task that asked for this fixture
cited `3db4ad99b33f0a591fcc71167bb7410e10a477429d48a0105afd17bf629b182c`, which is
not the digest of the file in this tree (line endings or a later edit are the
likely cause; unresolved). That digest may be the one of the bytes SPHERE serves,
which is the first thing to compare when the fixture is re-recorded.

Shape assumptions, none of them confirmed against SPHERE:

- The metadata sits at the top (`_id`, `name`, `slug`, `version`, `private`, `yaml`),
  using the keys `openbinding_gateway.sphere_client` already reads, and the
  Pricing2Yaml content sits under `pricing`. The real response may place the
  content at the top level or under another key.
- Unlimited allowances (`.inf` in the YAML) are `null`, as SPHERE's JSON and
  token serialisation does; JSON has no infinity.
- The `yaml` path and `_id` come from the permanent link and the gateway's
  accepted URL patterns, not from an observed response.

To re-record: fetch the URL above with `curl -H 'x-api-key: <key>'`, save the body
here pretty-printed under a name that carries the version, update this file with
the date and the digest, and adjust the test's `pricing` path if the shape differs.
