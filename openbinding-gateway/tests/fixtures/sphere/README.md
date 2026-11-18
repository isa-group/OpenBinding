# Recorded SPHERE answers

Recorded from the public, anonymous API of https://sphere.score.us.es by
`openbinding-gateway/tools/record_sphere_fixtures.py` (GET only, no key). `routes.json` lists every
recorded request (path and sorted query) with its body and headers files; `tests/sphere_recorded.py`
serves exactly these, and the tests never reach the network.

**Licence note.** The pricings belong to their SPHERE authors (the `sphere`, `danruilop1`, `danvelcam`
and `atenea` organizations). They are recorded for this repository's tests only and are not
redistributed beyond them. `derived/` and `users-me.json` are synthetic (see below). The frontend's copy
(`frontend/src/test/fixtures/sphere`, written by `tools/dump_frontend_fixtures.py`), which its unit tests and
mocked Playwright specs draw and preview, is under the same note.

## Versions

| pricingId | versionId | label | syntax | SPHERE organization | collection | set | sha256 | contentHash | bytes | fetched |
|---|---|---|---|---|---|---|---|---|---|---|
| `6ab0a323697330667ccce8cd` | `6921867e7004563bd918e7e8` | 1.0.0 | 3.0 | sphere | spherelab | TomatoMeter (sphere) | `73cf9f4c6ff5a479…` | `6959b67702fecdd1…` | 4099 | 2026-11-18 |
| `6adf1a6240e55445692b6f14` | `6adf1a62daa2ba78b21d7119` | 2026-10 | 3.1 | danruilop1 | - | email set B: SendGrid (danruilop1) | `33e896342510b572…` | `d709583a54fcdd54…` | 17346 | 2026-11-18 |
| `6ade364540e55445692b0eda` | `6ade36454b2b5b01c587db3d` | 2026-10 | 3.1 | danruilop1 | - | email set B: Mailgun (danruilop1) | `b2b3b509a9971708…` | `f845f9efadbaa7b0…` | 20971 | 2026-11-18 |
| `6ade2d4440e55445692b07f1` | `6ade2d444b2b5b01c587d80d` | 2026-10 | 3.1 | danruilop1 | - | email set B: Brevo (danruilop1) | `a6298efd2074dcc4…` | `aa873429290fd42d…` | 47191 | 2026-11-18 |
| `6ade2d2540e55445692b07c6` | `6ade2d254b2b5b01c587d7ee` | 2026-10 | 3.1 | danruilop1 | - | email set B: Resend (danruilop1) | `c134b13a863e9ea2…` | `dfdca3af5a173ec3…` | 20703 | 2026-11-18 |
| `6ade2f3b40e55445692b09aa` | `6ade2f3b4b2b5b01c587d8f5` | 2026-10 | 3.1 | danruilop1 | - | email set B: Postmark (danruilop1) | `2a8c90927e53c7a4…` | `f9cdbc7fe5214e2c…` | 17449 | 2026-11-18 |
| `6ade2ef740e55445692b094f` | `6ade2ef74b2b5b01c587d8b4` | 2026-10 | 3.1 | danruilop1 | - | sendgrid@rapidapi (danruilop1) | `c74fcd4fc5a0fbd2…` | `b8491de1f8c5157a…` | 3335 | 2026-11-18 |
| `6ae0772d40e55445692c0143` | `6ae634e3f99de6a6f95a42c5` | 2026-10-31 | 3.1 | danvelcam | email-apis-pricing-intelligence | email set A: SendGrid (danvelcam) | `a5dfb2dc22704b41…` | `7318ab911ae793f1…` | 9219 | 2026-11-18 |
| `6ae077ac40e55445692c01ce` | `6ae6349ff99de6a6f95a4282` | 2026-10-31 | 3.1 | danvelcam | email-apis-pricing-intelligence | email set A: Mailgun (danvelcam) | `ed44a26c52d6a069…` | `abddf643539b7155…` | 10864 | 2026-11-18 |
| `6ae0768440e55445692c0081` | `6ae07684daa2ba78b21d73ce` | 2026-09-16 | 3.1 | danvelcam | email-apis-pricing-intelligence | email set A: Brevo (danvelcam) | `bcb542cf645468a8…` | `0ec0e5a2fb0be127…` | 6948 | 2026-11-18 |
| `6ae076f340e55445692c0101` | `6ae076f3daa2ba78b21d7422` | 2026-09-01 | 3.1 | danvelcam | email-apis-pricing-intelligence | email set A: Resend (danvelcam) | `22bf127b76af2bc3…` | `7899f7abe1144ab8…` | 6382 | 2026-11-18 |
| `6ae0776f40e55445692c018c` | `6ae0776fdaa2ba78b21d7476` | 2026-08-03 | 3.1 | danvelcam | email-apis-pricing-intelligence | email set A: Postmark (danvelcam) | `5fa0c79604de4154…` | `76ed6b93372634ac…` | 10339 | 2026-11-18 |
| `6ab0a323697330667cccea11` | `698222e314b5a1547fbcbb95` | 2026 | 3.0 | sphere | - | Resend (sphere), ambiguous owner/name | `317ed31a7bd5ef09…` | `e804423937ce7cde…` | 10313 | 2026-11-18 |
| `6ab0a323697330667ccce8e9` | `69639298641bc8e6c0f764d1` | 2026 | 3.1 | sphere | modelling-apis-v1 | Resend (sphere), ambiguous owner/name | `8bed0936f1489fc0…` | `6185aea15dd9f49d…` | 10260 | 2026-11-18 |
| `6ab0a323697330667ccce9c1` | `687e4b68102baa50f3a5c7b7` | 2021 | 3.1 | atenea | a-mint | Dropbox USD (atenea) | `09c6360e8f7fe636…` | `266509cffaa65de0…` | 14300 | 2026-11-18 |
| `6ab0a323697330667ccce9c1` | `687e4b68102baa50f3a5c7b5` | 2023 | 2.1 | atenea | a-mint | Dropbox USD (atenea) | `67db66eac39ffd3a…` | `5d88274b5225d396…` | 27088 | 2026-11-18 |
| `6ab0a323697330667ccce9c1` | `687e4b68102baa50f3a5c7b6` | 2024 | 3.1 | atenea | a-mint | Dropbox USD (atenea) | `e19c921004b502d9…` | `e903032ad03708d0…` | 33970 | 2026-11-18 |
| `6ab0a323697330667cccea2d` | `67e9769d3b1f997200c7c155` | 2024-07-16 | 3.1 | atenea | caise-2025 | Dropbox EUR (atenea) | `16ad850906517791…` | `4d71ed428621c652…` | 18468 | 2026-11-18 |
| `6ab0a323697330667cccea2d` | `67e9769d3b1f997200c7c153` | 2023-12-03 | 2.1 | atenea | caise-2025 | Dropbox EUR (atenea) | `e3ae98c8c77a9a18…` | `4d9b15f26ea879b2…` | 17109 | 2026-11-18 |
| `6ab0a323697330667cccea2d` | `67e9769d3b1f997200c7c152` | 2022-11-16 | 2.1 | atenea | caise-2025 | Dropbox EUR (atenea) | `6344af2808769fc9…` | `5972fbed4d9aa006…` | 12616 | 2026-11-18 |
| `6ab0a323697330667cccea2d` | `67e9769d3b1f997200c7c154` | 2021-11-20 | 2.1 | atenea | caise-2025 | Dropbox EUR (atenea) | `e248e1d5ec52cac2…` | `54fe67f68f085b43…` | 11080 | 2026-11-18 |
| `6ab0a323697330667ccce93d` | `67e975243b1f997200c7be7a` | 2025 | 2.1 | atenea | ieee-tsc-2025 | Dropbox (atenea), latest 2.1 | `7c8000f7c07a63b9…` | `0f97ae37e3d0aef2…` | 18348 | 2026-11-18 |
| `6ab0a323697330667ccce93d` | `67e975243b1f997200c7be79` | 2024-07-16 | 2.1 | atenea | ieee-tsc-2025 | Dropbox (atenea), latest 2.1 | `eefac884d7b8feb1…` | `e96f3898e9abe4c7…` | 18403 | 2026-11-18 |
| `6ab0a323697330667ccce93d` | `67e975243b1f997200c7be77` | 2023-12-03 | 2.1 | atenea | ieee-tsc-2025 | Dropbox (atenea), latest 2.1 | `e3ae98c8c77a9a18…` | `4d9b15f26ea879b2…` | 17109 | 2026-11-18 |
| `6ab0a323697330667ccce93d` | `67e975243b1f997200c7be76` | 2022-11-16 | 2.1 | atenea | ieee-tsc-2025 | Dropbox (atenea), latest 2.1 | `6344af2808769fc9…` | `5972fbed4d9aa006…` | 12616 | 2026-11-18 |
| `6ab0a323697330667ccce93d` | `67e975243b1f997200c7be78` | 2021-11-20 | 2.1 | atenea | ieee-tsc-2025 | Dropbox (atenea), latest 2.1 | `e248e1d5ec52cac2…` | `54fe67f68f085b43…` | 11080 | 2026-11-18 |
| `6ab0a323697330667ccce9d9` | `687e3ca4102baa50f3a5c50d` | 2024-07-16 | 2.1 | atenea | spectra-v120 | Dropbox (atenea) | `ff060eb87a180843…` | `fad0d920046f3dbf…` | 22839 | 2026-11-18 |
| `6ab0a323697330667ccce891` | `6ada6dbd4b2b5b01c587d17f` | 0.2.0 | 3.1 | openbinding | - | OpenBinding | `4b9c7203c2771991…` | `3db4ad99b33f0a59…` | 8676 | 2026-11-18 |

## Other answers

- `<pricingId>/manifest.json`: `GET /api/v1/public/pricings/<pricingId>` (all versions, newest per SPHERE's order).
- `permalinks/<pricingId>.json`: `GET /api/v1/permalinks/pricing/<pricingId>` (organization id and slug).
- `orgs/<organizationId>.json`: `GET /api/v1/orgs/<organizationId>` (the organization name of a family).
- `org-pricings/<organizationId>.<page>.json`: `GET /api/v1/pricings/<organizationId>?limit=24&offset=<24·page>`.
- `orgs-public/<q>.json`: `GET /api/v1/orgs/public?q=<q>` (non-personal organizations only).
- `search/<query>.json`: `GET /api/v1/pricings?…` (discovery, with SPHERE's whole-result histograms).

## Synthetic files (not fetched)

- `derived/mailgun-renamed.yml`: the recorded set-B Mailgun version with `saasName` changed (a rename; same
  functional hash, other bytes).
- `derived/mailgun-scale.yml`: the same version with SCALE's `emailsPerMonth` raised by 1000 (a second version
  for the cross-version comparisons; no recorded real family has two 3.x versions sharing a numeric plan).
- `users-me.json`: a `/users/me` answer with no real personal data (the email is `example.invalid`).

98 recorded requests.
