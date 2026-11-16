# Third-party notices

## Universidad de Sevilla mark

The compact Universidad de Sevilla mark shown only for verified institutional
accounts is reproduced unchanged from the SPHERE project asset. Universidad de
Sevilla names and marks remain the property of Universidad de Sevilla; their
presence identifies the account's CAS identity provider and does not by itself
state sponsorship or endorsement. See the University's official visual identity
guidance at https://www.us.es/laUS/imagen-corporativa.

OpenBinding remains an independent project. The platform adapts product and implementation
patterns from the following MIT-licensed projects:

| Project | Revision inspected | Use in OpenBinding |
|---|---|---|
| [SPHERE](https://github.com/SCORELabUS/SPHERE) | `73779a8af260adb4c7de981bd479327d7b82f97a` | Navigation, resource lifecycle, administration and pricing-management patterns; the composition screens and the study front rewritten after SPHERE's pricing screens follow its patterns (no code copied). The files that port SPHERE code are listed under "Code ported from SPHERE" |
| [SPHERE docs](https://github.com/isa-group/sphere-docs) | `107c5451e464e77a87a1f8b72dd71fa9d9e93231` | Documentation structure, API explorer and deployment patterns |
| [SPACE](https://github.com/isa-group/SPACE) | `79aea10c9acff1d85e4931d09aa21d3a253d1ce1` (`v1.5.0`) | Contract and pricing deployment integration |
| [space-python-client](https://github.com/Alex-GF/space-python-client) | `1a61898adca73ca500eca4758c24d32f673dd790` (`v1.1.0`) | Official SPACE Python client integration |
| [Pricing4TS](https://github.com/Alex-GF/Pricing4TS) | `0.11.1` | Pricing2Yaml 3.1 parsing and validation for TypeScript |
| [space-react-client](https://github.com/Alex-GF/space-react-client) | `0.4.0` | Browser presentation of SPACE-evaluated feature state for React |
| [pricing-renderer](https://github.com/javiercavlop/pricing-renderer) | `0.2.0` | Public rendering of the active iPricing for the web |
| [lz-string](https://github.com/pieroxy/lz-string) | `1.5.0` | Compressing a composition into the `#composition=` fragment of a share link |
| [openapi-typescript](https://github.com/openapi-ts/openapi-typescript) | `7.13.0` (development only) | Generating the frontend's API types from `docs/openapi.json` |
| [@codemirror/lang-xml](https://github.com/codemirror/lang-xml) | `6.1.0` | Highlighting the BPMN (XML) files of a package in the problem editor's code view |

The MIT notice applying to those projects follows:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to inclusion of the copyright and permission
> notices. The Software is provided "AS IS", without warranty of any kind.

The complete upstream license texts remain available in the linked repositories.
OpenBinding source and documentation retain the license declared by this repository.
Names, logos and institutional marks are not transferred by the MIT license and
must not be used to imply an endorsement.

## Code ported from SPHERE

The files below port SPHERE code at revision `73779a8a`, and each names its origin in its header (the SVGs, which
cannot carry one, are named here). A ported test is
listed with its module:

| File | SPHERE origin |
|---|---|
| `openbinding-gateway/src/openbinding_gateway/composition/diff.py` | `frontend/src/modules/pricing/utils/pricing-diff.ts` (the PricingDiff shape and rules) |
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/application/fork.py` | `PricingService.forkPricing` and its `ForkedFrom` snapshot (the fork rules) |
| `frontend/src/shared/sphere/text-diff.ts` | `frontend/src/modules/pricing/utils/text-diff.ts` (copied verbatim) |
| `frontend/src/shared/sphere/requested-version.ts` | `frontend/src/modules/pricing/pages/card/requested-version.ts` (copied verbatim) |
| `frontend/src/shared/sphere/change-summary.ts`, with its test `change-summary.test.ts` | `frontend/src/modules/pricing/utils/change-summary.ts` and `frontend/test/change-summary.test.ts` (adapted: composition sections, candidate and value changes, the gateway's diff) |
| `frontend/src/shared/sphere/composition-fragment.ts`, with its test `composition-fragment.test.ts` | `frontend/src/modules/pricing-editor/services/pricing-fragment.ts`, the encoder of `frontend/src/modules/pricing-editor/services/export.service.ts` and `frontend/test/pricing-fragment.test.ts` (adapted: the `#composition=` fragment) |
| `frontend/src/features/composition-editor/NewVersionMenu.tsx` | `frontend/src/modules/pricing/components/new-version-menu/index.tsx` (adapted: the outside-click, Escape and `role=menu` logic kept; the Composition2Yaml editor's options and OpenBinding's markup) |
| `frontend/src/widgets/change-summary/useVersionChanges.ts`, with its test `useVersionChanges.test.ts` | `frontend/src/modules/pricing/components/pricing-version-graph/use-version-changes.ts` and `use-version-changes.test.tsx` (adapted: the 150 ms delay, the cache keyed by credential and version pair, the retry and the stale guard kept; the gateway's diff instead of both YAML files; the test on `renderHook`) |
| `openbinding-gateway/src/openbinding_gateway/services/organizations.py` | `api/src/main/utils/slug-manager.ts` (`generateSlug`, `deduplicateSlug`), `api/src/main/config/defaultAvatars.ts` (the predefined avatars, the colour check) and `api/src/main/services/OrganizationService.ts` (`updateAvatar`, `removeAvatar`, the default colours) (adapted: accents folded, reserved slugs never derived, uploads kept as blobs) |
| `openbinding-gateway/src/openbinding_gateway/static/avatars/avatar-*.svg` | `api/public/static/avatars/users/default/avatar-*.svg` (copied verbatim) |
| `openbinding-gateway/src/openbinding_gateway/routes/organizations.py` (the public, profile, hierarchy, invitation-code and ownership routes) | `api/src/main/services/OrganizationService.ts` (`indexPublicRoots`, `getHierarchy`, `createInvitation`, `previewInvitation`, `joinViaInvitation`, `inviteUsersToOrganization`, `transferOwnership`, `removeMember`) and `api/src/main/routes/OrganizationRoutes.ts` (adapted: one transaction, 404 for non-readers, public profiles only with a public composition) |
| `openbinding-gateway/src/openbinding_gateway/routes/notifications.py` and `openbinding-gateway/src/openbinding_gateway/modules/shared/application/notifications.py` | `api/src/main/controllers/NotificationController.ts`, `api/src/main/routes/NotificationRoutes.ts` and `api/src/main/services/NotificationService.ts` (adapted: the kinds, the per-kind channels, the unread count and the stream's events kept; a single-use ticket instead of the access token in the stream's URL, the stream reading committed rows instead of an in-process client map, deleting only one's own notifications) |
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/application/listing.py` | `api/src/main/repositories/mongoose/aggregators/pricings/filters-data-generator.ts` (adapted: the ten-bucket histogram up to the 80th percentile kept; facets over every match, each ignoring its own filter, and a value equal to the percentile counted) |

SPHERE's licence, verbatim:

```text
MIT License

Copyright (c) 2024 Alejandro García Fernández

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
