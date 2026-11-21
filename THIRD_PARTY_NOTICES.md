# Third-party notices

## Universidad de Sevilla mark

The compact Universidad de Sevilla mark shown only for accounts with a verified
institutional e-mail is reproduced unchanged from the SPHERE project asset.
Universidad de Sevilla names and marks remain the property of Universidad de
Sevilla; their presence identifies the account's institutional e-mail and does
not by itself state sponsorship or endorsement. See the University's official visual identity
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
| [pricing-renderer](https://github.com/javiercavlop/pricing-renderer) | `0.2.0` | Public rendering of the active iPricing for the web; through its public API only (`pricing-renderer`, `/yaml`, `/react`), the SPHERE wizard's plan picker, upstream plan cards, offering storefronts and the plan change review (`compareSelections`, `PricingChangeReview`), with `String()` as the one extra expression function |
| [lz-string](https://github.com/pieroxy/lz-string) | `1.5.0` | Compressing a composition into the `#composition=` fragment of a share link |
| [openapi-typescript](https://github.com/openapi-ts/openapi-typescript) | `7.13.0` (development only) | Generating the frontend's API types from `docs/openapi.json` |
| [@lezer/json](https://github.com/lezer-parser/json) | `1.0.3` | Reading where a JSON Pointer lands in the text of a package file, to place the gateway's BIM findings |
| [@lezer/yaml](https://github.com/lezer-parser/yaml) | `1.0.4` | Reading where things are in a Composition2Yaml text (the key path at the cursor, a scalar's range) for completion and the label |

### Libraries of SPHERE's frontend stack

The frontend takes the libraries SPHERE's frontend is built on, so that SPHERE's code can be reused as it is
(`docs/adr/0053-frontend-on-sphere-stack.md`). They are dependencies, not copies; their licences travel with the
packages.

| Package | Version | Licence | Use in OpenBinding |
|---|---|---|---|
| [tailwindcss](https://github.com/tailwindlabs/tailwindcss) and `@tailwindcss/vite` | `4.3.5` | MIT | Styling with SPHERE's `tp` design tokens and its preflight |
| [framer-motion](https://github.com/motiondivision/motion) | `12.43.0` | MIT | SPHERE's motion variants, tab underlines and dialog transitions |
| [react-icons](https://github.com/react-icons/react-icons) | `5.7.0` | MIT (each icon set keeps its own licence, listed in the package) | Icons, through SPHERE's iconify shim |
| [react-loading-skeleton](https://github.com/dvtng/react-loading-skeleton) | `3.5.0` | MIT | SPHERE's loading skeletons |
| [date-fns](https://github.com/date-fns/date-fns) | `4.4.0` | MIT | Relative and formatted dates |
| [react-dropzone](https://github.com/react-dropzone/react-dropzone) | `14.4.1` | MIT | File drop areas |
| [dnd-kit](https://github.com/clauderic/dnd-kit) (`@dnd-kit/core`, `sortable`, `utilities`) | `6.3.1`, `10.0.0`, `3.2.2` | MIT | Drag and drop in the organization tree |
| [react-easy-crop](https://github.com/ValentinH/react-easy-crop) | `5.5.7` | MIT | Cropping organization avatars |
| [react-helmet-async](https://github.com/staylor/react-helmet-async) | `3.1.0` | Apache-2.0 | Page titles |
| [monaco-editor](https://github.com/microsoft/monaco-editor) and [@monaco-editor/react](https://github.com/suren-atoyan/monaco-react) | `0.52.2`, `4.7.0` | MIT | The code editors, bundled locally |
| [react-markdown](https://github.com/remarkjs/react-markdown) and [remark-gfm](https://github.com/remarkjs/remark-gfm) | `10.1.0`, `4.0.1` | MIT | The about pages |
| [prettier](https://github.com/prettier/prettier) and [prettier-plugin-tailwindcss](https://github.com/tailwindlabs/prettier-plugin-tailwindcss) | `3.9.4`, `0.8.1` (development only) | MIT | Formatting with SPHERE's settings |

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

## Pricing2Yaml readers followed

The Python Pricing2Yaml normaliser (`openbinding-gateway/src/openbinding_gateway/modules/plans/domain/pricing2yaml/`)
reads pricings as the two TypeScript readers do, so that the gateway and the screens agree. Each file names its origin.

| File | Origin | Use |
|---|---|---|
| `pricing2yaml/expression.py` | [pricing-renderer](https://github.com/javiercavlop/pricing-renderer) `v0.2.0` `src/core/expression.ts` (MIT, Copyright (c) 2026 Francisco Javier Cavero) | Grammar ported: the tokenizer, the precedence-climbing parser, the whitelist and the size limits; evaluation in `Decimal`, with `String(x)` as the one extra function |
| `frontend/src/modules/core/components/value-badge/originText.ts`, `candidate-matrix/CandidateMatrix.tsx` | [Pricing4TS](https://github.com/Alex-GF/Pricing4TS) `0.12.1` `pricing-validators.js` (`unlimitedValue`) | Semantics followed, no code copied: a generated value of `1e8` reads "unlimited" |
| `pricing2yaml/normalise.py`, `model.py`, `effective.py`, `units.py`, `summary.py` | pricing-renderer `v0.2.0` `src/core/normalize.ts`, `compare-values.ts`, `breakdown.ts`, `resolve.ts`; [Pricing4TS](https://github.com/Alex-GF/Pricing4TS) `0.12.1` `pricing-parser.js`, `pricing-validators.js`, `version-manager.js` (MIT, Copyright (c) 2024 Alejandro García Fernández) | Semantics followed, no code copied: defaults and overrides, add-on extensions, unlimited values (pricing4ts's `1e8` sentinel included), billing, the kept validations |

## Code ported from SCORETech Identity

The files below port code of [SCORELabUS/SCORETech-identity](https://github.com/SCORELabUS/SCORETech-identity) at
`215dffedf556294e2424f7c7b4e9bf57d038d66f` (tag `v0.1.11`, MIT, "Copyright (c) 2026 SCORE Lab") and name their origin in
their headers:

| File | Identity origin | Use |
|---|---|---|
| `openbinding-gateway/src/openbinding_gateway/modules/identity/domain/claims.py` | `packages/ui/src/avatar.tsx` (the twelve named avatar colours) and `provider/.../ApplicationUserClaims.java` (the avatar descriptor's shapes) | adapted |
| `openbinding-gateway/src/openbinding_gateway/models/avatars.py` | `provider/.../ApplicationUserClaims.java` (the three shapes of `scoretech_avatar`, its preset and icon ids) | pattern-only |
| `frontend/src/modules/core/components/user-avatar/avatar-assets.ts` | `packages/ui/src/avatar-assets.ts` (Identity's copy of SPHERE's predefined avatar artwork) | verbatim |
| `frontend/src/modules/core/components/user-avatar/identity-avatar.tsx` | `packages/ui/src/avatar.tsx` (the `Avatar` renderer; `react-icons/lu` for `lucide-react`) | adapted |
| `frontend/src/modules/core/components/user-avatar/avatar-values.ts` | `packages/ui/src/avatar.tsx` (`avatarPalette`, `avatarChoices`, the named colours, the initials) | adapted |

SCORETech Identity's licence, verbatim:

```text
MIT License

Copyright (c) 2026 SCORE Lab

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

## Code ported from SPACE

The files below port SPACE code at revision `3d35281` of [SCORELabUS/space](https://github.com/SCORELabUS/space) (MIT),
and each names its origin in its header:

| File | SPACE origin |
|---|---|
| `openbinding-gateway/src/openbinding_gateway/modules/identity/application/provisioning.py` | `api/src/main/services/SphereAuthService.ts` lines 119-160 (the pending sign-up and its completion with a chosen username) |
| `openbinding-gateway/src/openbinding_gateway/modules/identity/application/renewal.py` | `api/src/main/services/ScoretechIdentityService.ts` lines 342-381 (revoking the token a lost write obtained) |
| `frontend/src/modules/auth/pages/identity-username/index.tsx` (and the pending and complete calls of `frontend/src/modules/auth/api/identityApi.ts`) | `frontend/src/pages/sphere-auth/index.tsx` and `frontend/src/api/auth/sphereAuthApi.ts` (adapted: a first sign-in only, no linking; OpenBinding's auth layout and refusal wording) |

## Code ported from SPHERE

The files below port SPHERE code at revision `73779a8a`, and each names its origin in its header (the SVGs, which
cannot carry one, are named here). A ported test is
listed with its module:

| File | SPHERE origin |
|---|---|
| `openbinding-gateway/src/openbinding_gateway/composition/diff.py` | `frontend/src/modules/pricing/utils/pricing-diff.ts` (the PricingDiff shape and rules) |
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/application/fork.py` | `PricingService.forkPricing` and its `ForkedFrom` snapshot (the fork rules) |
| `openbinding-gateway/src/openbinding_gateway/modules/identity/adapters/oidc.py` | `api/src/main/services/ScoretechIdentityService.ts` (discovery, the token grant and verification; stricter: `aud` and `azp` on both tokens, `typ`, the `kid` and refetch rules, an hour of discovery cache) |
| `openbinding-gateway/src/openbinding_gateway/modules/identity/adapters/routes.py` and `adapters/cookies.py` | `api/src/main/controllers/ScoretechIdentityController.ts` (the login, callback, session and logout routes and their cookies; adapted: `__Host-` cookies at `Path=/`, mode declared per route) |
| `openbinding-gateway/src/openbinding_gateway/modules/identity/application/flows.py` | `ScoretechIdentityService.begin` and `complete` (PKCE, state, nonce, the browser binding compared before the flow is consumed) |
| `openbinding-gateway/src/openbinding_gateway/modules/identity/application/sessions.py` and `application/renewal.py` | `ScoretechIdentityService.active`, `session` and `logout` (adapted: sessions in PostgreSQL with a sealed refresh token, a waiting lock with an owner token, a generation compare-and-swap) |
| `openbinding-gateway/src/openbinding_gateway/modules/identity/application/config.py` and the Identity settings of `core/settings.py` | `api/src/main/services/scoretech/config.ts` (`publicUrl`, the callback and account URL rules, `authenticationConfig`) |
| `docs/IDENTITY.md` | `docs/scoretech-identity.md` (adapted) |
| `frontend/src/modules/core/theme/editor-themes/GitHub-Dark.json` | `frontend/src/modules/core/theme/editor-themes/GitHub-Dark.json` | verbatim |
| `frontend/src/modules/core/theme/editor-themes/Textmate.json` | `frontend/src/modules/core/theme/editor-themes/Textmate.json` | verbatim |
| `frontend/src/modules/core/utils/sphere/text-diff.ts` | `frontend/src/modules/pricing/utils/text-diff.ts` (copied verbatim) |
| `frontend/src/modules/core/utils/sphere/requested-version.ts` | `frontend/src/modules/pricing/pages/card/requested-version.ts` (copied verbatim) |
| `frontend/src/modules/core/utils/sphere/change-summary.ts`, with its test `change-summary.test.ts` | `frontend/src/modules/pricing/utils/change-summary.ts` and `frontend/test/change-summary.test.ts` (adapted: composition sections, candidate and value changes, the gateway's diff) |
| `frontend/src/modules/core/utils/sphere/composition-fragment.ts`, with its test `composition-fragment.test.ts` | `frontend/src/modules/pricing-editor/services/pricing-fragment.ts`, the encoder of `frontend/src/modules/pricing-editor/services/export.service.ts` and `frontend/test/pricing-fragment.test.ts` (adapted: the `#composition=` fragment) |
| `frontend/src/modules/composition-editor/components/composition-editor/NewVersionMenu.tsx` | `frontend/src/modules/pricing/components/new-version-menu/index.tsx` (adapted: the outside-click, Escape and `role=menu` logic kept; the Composition2Yaml editor's options and OpenBinding's markup) |
| `frontend/DESIGN.md` | `DESIGN.md` (copied verbatim; a note on OpenBinding's differences follows its front matter) |
| `frontend/src/modules/composition/components/version-graph/useVersionChanges.ts`, with its test `useVersionChanges.test.ts` | `frontend/src/modules/pricing/components/pricing-version-graph/use-version-changes.ts` and `use-version-changes.test.tsx` (adapted: the 150 ms delay, the cache keyed by credential and version pair, the retry and the stale guard kept; the gateway's diff instead of both YAML files; the test on `renderHook`) |
| `openbinding-gateway/src/openbinding_gateway/services/organizations.py` | `api/src/main/utils/slug-manager.ts` (`generateSlug`, `deduplicateSlug`), `api/src/main/config/defaultAvatars.ts` (the predefined avatars, the colour check) and `api/src/main/services/OrganizationService.ts` (`updateAvatar`, `removeAvatar`, the default colours, and at `fc776b4d` `ensurePersonalOrganizationForUser`) (adapted: accents folded, reserved slugs never derived, uploads kept as blobs; a personal organization's slug without `.` or `_`, idempotent, pseudonymised rather than deleted with its account) |
| `openbinding-gateway/src/openbinding_gateway/static/avatars/avatar-*.svg` | `api/public/static/avatars/users/default/avatar-*.svg` (copied verbatim) |
| `openbinding-gateway/src/openbinding_gateway/routes/organizations.py` (the public, profile, hierarchy, invitation-code and ownership routes) | `api/src/main/services/OrganizationService.ts` (`indexPublicRoots`, `getHierarchy`, `createInvitation`, `previewInvitation`, `joinViaInvitation`, `inviteUsersToOrganization`, `transferOwnership`, `removeMember`) and `api/src/main/routes/OrganizationRoutes.ts` (adapted: one transaction, 404 for non-readers, public profiles only with a public composition) |
| `openbinding-gateway/src/openbinding_gateway/modules/plans/domain/content_hash.py` (with the YAML 1.2 core reading of `yaml12.py`) | `api/src/main/services/PermanentLinkService.ts` (`functionalHash`: js-yaml load, `saasName` dropped, sorted keys, `JSON.stringify`, SHA-256), unchanged at `fc776b4d` (adapted: Python, with JavaScript number formatting and key order) |
| `openbinding-gateway/src/openbinding_gateway/routes/notifications.py` and `openbinding-gateway/src/openbinding_gateway/modules/shared/application/notifications.py` | `api/src/main/controllers/NotificationController.ts`, `api/src/main/routes/NotificationRoutes.ts` and `api/src/main/services/NotificationService.ts` (adapted: the kinds, the per-kind channels, the unread count and the stream's events kept; a single-use ticket instead of the access token in the stream's URL, the stream reading committed rows instead of an in-process client map, deleting only one's own notifications) |
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/application/listing.py` | `api/src/main/repositories/mongoose/aggregators/pricings/filters-data-generator.ts` (adapted: the ten-bucket histogram up to the 80th percentile kept; facets over every match, each ignoring its own filter, and a value equal to the percentile counted) |
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/application/graph.py` | `api/src/main/services/PricingService.ts` (`graph`, `_graphLane`, `_unavailableSourceLane`, `GRAPH_MAX_LANES`) (adapted: composition lanes; no unavailable lane, and no edge to it, for a reader who is not a member) |
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/application/follows.py` | `api/src/main/services/PricingFollowService.ts` (adapted: a reader of the composition follows it; a new version tells every follower who still reads it, skipping the author) |
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/adapters/link_routes.py` | `api/src/main/routes/PermanentLinkRoutes.ts`, `api/src/main/services/PermanentLinkService.ts` (`resolve`, `archiveName`) and `api/src/main/routes/PricingFollowRoutes.ts` (adapted: the ETag, `Vary` and the one 404 kept; `private, no-store` for every caller; a version named by id or label) |

<!-- sphere-convergence:start -->

The frontend files of the move to SPHERE's frontend (`docs/adr/0053-frontend-on-sphere-stack.md`), at revision
`73779a8a` of `main` (and `694f292b03` of its `feat/pricing-renderer` branch, for the pricing-renderer bridge, `/pricing`,
the configuration compare tray, the study front and the SPHERE wizard's plan picker and selection mapping, as each header says), each with its reuse class: **verbatim** (copied; only imports, wording and types changed), **adapted**
(copied, with logic changed; the header says what) or **pattern-only** (the layout followed, the code written here).
Generated from the origin header of each file. The F4 screens (the Operation tab, the environment and template cards,
the adopt dialog, the adoption history and the feed key panel) copy SPHERE at `fc776b4d`, where those files are unchanged
since `73779a8a`; their rows say so.

| File | SPHERE origin | Class |
|---|---|---|
| `frontend/src/modules/admin/api/adminApi.ts` | `frontend/src/modules/pricing/api/pricingsApi.ts` | pattern-only |
| `frontend/src/modules/admin/components/admin-parts/index.tsx` | `frontend/src/modules/settings/components/AccountSection.tsx` | pattern-only |
| `frontend/src/modules/admin/pages/admin/index.tsx` | `frontend/src/modules/settings/pages/SettingsPage.tsx` | adapted |
| `frontend/src/modules/admin/pages/admin/sections.ts` | `frontend/src/modules/settings/pages/SettingsPage.tsx` | adapted |
| `frontend/src/modules/admin/pages/user/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | adapted |
| `frontend/src/modules/api-keys/api/apiKeysApi.ts` | `frontend/src/modules/api-keys/api/apiKeysApi.ts` | adapted |
| `frontend/src/modules/api-keys/components/ApiKeyCard.tsx` | `frontend/src/modules/api-keys/components/ApiKeyCard.tsx` | adapted |
| `frontend/src/modules/api-keys/components/ApiKeyList.tsx` | `frontend/src/modules/api-keys/components/ApiKeyList.tsx` | adapted |
| `frontend/src/modules/api-keys/components/CreateApiKeyDialog.tsx` | `frontend/src/modules/api-keys/components/CreateApiKeyDialog.tsx` | adapted |
| `frontend/src/modules/api-keys/components/organization-search-input.tsx` | `frontend/src/modules/core/components/organization-search-input.tsx` | adapted |
| `frontend/src/modules/api-keys/components/scope-selector.tsx` | `frontend/src/modules/core/components/scope-selector.tsx` | adapted |
| `frontend/src/modules/api-keys/pages/api-keys-page/index.tsx` | `frontend/src/modules/api-keys/pages/ApiKeysPage.tsx` | adapted |
| `frontend/src/modules/api-keys/utils/accessLevel.ts` | `frontend/src/modules/core/components/scope-selector.tsx` | adapted (extracted) |
| `frontend/src/modules/auth/components/animated-logo/index.tsx` | `frontend/src/modules/auth/components/animated-logo/index.tsx` | adapted |
| `frontend/src/modules/auth/api/identityApi.ts` | `frontend/src/modules/auth/api/identityApi.ts` | adapted |
| `frontend/src/modules/auth/components/identity-redirect.tsx` | `frontend/src/modules/auth/components/identity-redirect.tsx` | adapted |
| `frontend/src/modules/auth/contexts/authConfig.tsx` and `authConfigContext.ts` | `frontend/src/modules/auth/contexts/authConfig.tsx` | adapted |
| `frontend/src/modules/auth/components/auth-field/index.tsx` | `frontend/src/modules/auth/components/login-form/index.tsx` | pattern-only |
| `frontend/src/modules/auth/components/auth-layout/index.tsx` | `frontend/src/modules/auth/components/auth-layout/index.tsx` | adapted |
| `frontend/src/modules/auth/components/auth-layout/variants.ts` | `frontend/src/modules/auth/components/auth-layout/index.tsx` | verbatim |
| `frontend/src/modules/auth/components/login-form/index.tsx` | `frontend/src/modules/auth/components/login-form/index.tsx` | adapted |
| `frontend/src/modules/auth/components/register-form/index.tsx` | `frontend/src/modules/auth/components/register-form/index.tsx` | adapted |
| `frontend/src/modules/auth/pages/authentication-page/index.tsx` | `frontend/src/modules/auth/pages/authentication-page/index.tsx` | adapted |
| `frontend/src/modules/auth/pages/forgot-password/index.tsx` | `frontend/src/modules/auth/pages/forgot-password/index.tsx` | adapted |
| `frontend/src/modules/auth/pages/reset-password/index.tsx` | `frontend/src/modules/auth/pages/reset-password/index.tsx` | adapted |
| `frontend/src/modules/beta/components/beta-badge/index.tsx` | `frontend/src/modules/beta/components/beta-badge/index.tsx` | verbatim |
| `frontend/src/modules/beta/components/beta-gate/index.tsx` | `frontend/src/modules/beta/components/beta-gate/index.tsx` | verbatim |
| `frontend/src/modules/beta/config/betaFeatures.ts` | `frontend/src/modules/beta/config/betaFeatures.ts` | adapted |
| `frontend/src/modules/beta/hooks/useBetaFeatures.ts` | `frontend/src/modules/beta/hooks/useBetaFeatures.ts` | adapted |
| `frontend/src/modules/composition-editor/components/editor-account-menu/index.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/editor-account-menu.tsx` | adapted |
| `frontend/src/modules/composition-editor/components/templates-menu/index.tsx` | `frontend/src/modules/pricing-editor/components/templates-menu/index.tsx` | adapted |
| `frontend/src/modules/composition-editor/contexts/editorValueContext.ts` | `frontend/src/modules/pricing-editor/contexts/editorValueContext.ts` | adapted |
| `frontend/src/modules/composition-editor/hooks/useCompositionSnippets.ts` | `frontend/src/modules/pricing-editor/hooks/usePricing2YamlSnippets.ts` | adapted |
| `frontend/src/modules/composition-editor/hooks/useEditorValue.ts` | `frontend/src/modules/pricing-editor/hooks/useEditorValue.ts` | adapted |
| `frontend/src/modules/composition-editor/layouts/editor-layout/editor-header.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/editor-header.tsx` | adapted |
| `frontend/src/modules/composition-editor/layouts/editor-layout/index.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/index.tsx` | adapted |
| `frontend/src/modules/composition-editor/layouts/editor-layout/publish-modal.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx` | adapted |
| `frontend/src/modules/composition-editor/pages/composition-editor/index.tsx` | `frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/index.tsx` | adapted |
| `frontend/src/modules/composition-editor/services/export.ts` | `frontend/src/modules/pricing-editor/services/export.service.ts` | adapted |
| `frontend/src/modules/composition-editor/services/snippets/index.ts` | `frontend/src/modules/pricing-editor/services/pricing2yaml/snippets/index.ts` | verbatim |
| `frontend/src/modules/composition-editor/services/snippets/insert.ts` | `frontend/src/modules/pricing-editor/services/pricing2yaml/snippets/insert.ts` | verbatim |
| `frontend/src/modules/composition-editor/services/snippets/monaco.ts` | `frontend/src/modules/pricing-editor/services/pricing2yaml/snippets/monaco.ts` | adapted |
| `frontend/src/modules/composition-editor/services/snippets/templates.ts` | `frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/templates/snippets.ts` | pattern-only |
| `frontend/src/modules/composition-editor/services/snippets/types.ts` | `frontend/src/modules/pricing-editor/services/pricing2yaml/snippets/types.ts` | adapted |
| `frontend/src/modules/composition/api/compositionsApi.ts` | `frontend/src/modules/pricing/api/pricingsApi.ts` | adapted |
| `frontend/src/modules/composition/components/adopt-dialog/index.tsx` | `frontend/src/modules/pricing/components/fork-pricing-modal/index.tsx` (at `fc776b4d`) | pattern-only |
| `frontend/src/modules/composition/components/adoption-history/index.tsx` | `frontend/src/modules/pricing/components/pricing-versions-tab/index.tsx` (at `fc776b4d`) | adapted |
| `frontend/src/modules/composition/components/analytics-tab/index.tsx` | `frontend/src/modules/pricing/components/pricing-analytics-tab/index.tsx` | adapted |
| `frontend/src/modules/composition/components/composition-card/index.tsx` | `frontend/src/modules/pricing/components/pricing-card/index.tsx` | adapted |
| `frontend/src/modules/composition/components/composition-import-modal/index.tsx` | `frontend/src/modules/pricing/components/pricing-import-modal/index.tsx` | adapted |
| `frontend/src/modules/composition/components/composition-settings-tab/index.tsx` | `frontend/src/modules/pricing/components/pricing-settings-tab/index.tsx` | adapted |
| `frontend/src/modules/composition/components/composition-tree/index.tsx` | `frontend/src/modules/pricing/components/pricing-tree/index.tsx` | adapted |
| `frontend/src/modules/composition/components/compositions-tab/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/PricingsTab.tsx` | adapted |
| `frontend/src/modules/composition/components/configuration-details-modal/index.tsx` | `frontend/src/modules/pricing/components/configuration-details-modal/index.tsx` | adapted |
| `frontend/src/modules/composition/components/configuration-space-item/index.tsx` | `frontend/src/modules/pricing/components/configuration-space-item/index.tsx` | adapted |
| `frontend/src/modules/composition/components/configuration-space-view/compare-slots.ts` | `frontend/src/modules/pricing/components/configuration-space-view/compare-slots.ts` | adapted |
| `frontend/src/modules/composition/components/configuration-space-view/compare-tray.tsx` | `frontend/src/modules/pricing/components/configuration-space-view/compare-tray.tsx` | adapted |
| `frontend/src/modules/composition/components/configuration-space-view/configuration-comparison.tsx` | `frontend/src/modules/pricing/components/configuration-space-view/configuration-comparison.tsx` | adapted |
| `frontend/src/modules/composition/components/configuration-space-view/index.tsx` | `frontend/src/modules/pricing/components/configuration-space-view/index.tsx` | adapted |
| `frontend/src/modules/composition/components/create-composition-form/index.tsx` | `frontend/src/modules/pricing/components/create-pricing-form/index.tsx` | adapted |
| `frontend/src/modules/composition/components/follow-button/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | adapted |
| `frontend/src/modules/composition/components/environment-card/index.tsx` | `frontend/src/modules/pricing/components/collection-card/index.tsx` (at `fc776b4d`) | adapted |
| `frontend/src/modules/composition/components/environment-key-panel/index.tsx` | `frontend/src/modules/api-keys/pages/ApiKeysPage.tsx` (at `fc776b4d`; the reveal-once block, through OpenBinding's API keys page) | adapted |
| `frontend/src/modules/composition/components/fork-composition-modal/index.tsx` | `frontend/src/modules/pricing/components/fork-pricing-modal/index.tsx` | adapted |
| `frontend/src/modules/composition/components/get-composition-menu/index.tsx` | `frontend/src/modules/pricing/components/get-pricing-menu/index.tsx` | adapted |
| `frontend/src/modules/composition/components/new-version-menu/index.tsx` | `frontend/src/modules/pricing/components/new-version-menu/index.tsx` | adapted |
| `frontend/src/modules/composition/components/operation-tab/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/CollectionsTab.tsx` (at `fc776b4d`) | adapted |
| `frontend/src/modules/composition/components/pricing-link-modal/index.tsx` | `frontend/src/modules/pricing/components/pricing-link-modal/index.tsx` | adapted |
| `frontend/src/modules/composition/components/stats/index.tsx` | `frontend/src/modules/pricing/components/stats/index.tsx` | adapted |
| `frontend/src/modules/composition/components/template-card/index.tsx` | `frontend/src/modules/pricing/components/collection-card/index.tsx` (at `fc776b4d`) | adapted |
| `frontend/src/modules/composition/components/version-diff/file-diff-view.tsx` | `frontend/src/modules/pricing/components/pricing-version-diff/file-diff-view.tsx` | adapted |
| `frontend/src/modules/composition/components/version-diff/index.tsx` | `frontend/src/modules/pricing/components/pricing-version-diff/index.tsx` | adapted |
| `frontend/src/modules/composition/components/version-graph/change-summary-card.tsx` | `frontend/src/modules/pricing/components/pricing-version-graph/change-summary-card.tsx` | adapted |
| `frontend/src/modules/composition/components/version-graph/index.tsx` | `frontend/src/modules/pricing/components/pricing-version-graph/index.tsx` | adapted |
| `frontend/src/modules/composition/components/versions-tab/index.tsx` | `frontend/src/modules/pricing/components/pricing-versions-tab/index.tsx` | adapted |
| `frontend/src/modules/composition/components/visibility-options/index.tsx` | `frontend/src/modules/pricing/components/visibility-options/index.tsx` | adapted |
| `frontend/src/modules/composition/components/yaml-source-panel/index.tsx` | `frontend/src/modules/pricing/components/yaml-source-panel/index.tsx` | adapted |
| `frontend/src/modules/composition/pages/card/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | adapted |
| `frontend/src/modules/composition/pages/create/index.tsx` | `frontend/src/modules/pricing/pages/create/index.tsx` | adapted |
| `frontend/src/modules/composition/pages/list/index.tsx` | `frontend/src/modules/pricing/pages/list/index.tsx` | adapted |
| `frontend/src/modules/composition/pages/permalink/index.tsx` | `frontend/src/modules/pricing/pages/permalink/index.tsx` | adapted |
| `frontend/src/modules/composition/pages/user-list/index.tsx` | `frontend/src/modules/pricing/pages/user-list/index.tsx` | adapted |
| `frontend/src/modules/core/components/404-logo/index.tsx` | `frontend/src/modules/core/components/404-logo/index.tsx` | adapted |
| `frontend/src/modules/core/components/action-button/index.tsx` | `frontend/src/modules/core/components/action-button/index.tsx` | adapted |
| `frontend/src/modules/core/components/alert-modal/index.tsx` | `frontend/src/modules/core/components/alert-modal/index.tsx` | adapted |
| `frontend/src/modules/core/components/alerts/index.tsx` | `frontend/src/modules/core/components/alerts/index.tsx` | adapted |
| `frontend/src/modules/core/components/badge/index.tsx` | `frontend/src/modules/beta/components/beta-badge/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/block-alert/index.tsx` | `frontend/src/modules/core/components/block-alert/index.tsx` | adapted |
| `frontend/src/modules/core/components/chip/index.tsx` | `frontend/src/modules/beta/components/beta-badge/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/code-editor/index.tsx` | `frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/command-palette/index.tsx` | `frontend/src/modules/core/components/command-palette/index.tsx` | adapted |
| `frontend/src/modules/core/components/composition-renderer/modes/showcase.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/confirm-modal/index.tsx` | `frontend/src/modules/core/components/confirm-modal/index.tsx` | adapted |
| `frontend/src/modules/core/components/copy-field/index.tsx` | `frontend/src/modules/core/components/copy-icon/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/copy-icon/index.tsx` | `frontend/src/modules/core/components/copy-icon/index.tsx` | adapted |
| `frontend/src/modules/core/components/data-table/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/MembersTab.tsx` | pattern-only |
| `frontend/src/modules/core/components/date-picker/index.tsx` | `frontend/src/modules/core/components/date-picker/index.tsx` | adapted |
| `frontend/src/modules/core/components/dual-range-slider/index.tsx` | `frontend/src/modules/pricing/components/dual-range-slider/index.tsx` | adapted |
| `frontend/src/modules/core/components/editor-chrome/index.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/editor-header.tsx` | adapted |
| `frontend/src/modules/core/components/empty-state/index.tsx` | `frontend/src/modules/organization/pages/organizations-list/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/error-boundary/index.tsx` | `frontend/src/modules/core/components/error-boundary/index.tsx` | adapted |
| `frontend/src/modules/core/components/file-upload-input/index.tsx` | `frontend/src/modules/core/components/file-upload-input/index.tsx` | adapted |
| `frontend/src/modules/core/components/filter-bar/index.tsx` | `frontend/src/modules/pricing/components/filter-bar/index.tsx` | adapted |
| `frontend/src/modules/core/components/filter-pills/index.tsx` | `frontend/src/modules/core/components/filter-bar/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/form-field/index.tsx` | `frontend/src/modules/organization/pages/create-organization/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/iconify/index.tsx` | `frontend/src/modules/core/components/iconify/index.tsx` | adapted |
| `frontend/src/modules/core/components/loaders/banter-loader/index.tsx` | `frontend/src/modules/core/components/loaders/banter-loader/index.tsx` | verbatim |
| `frontend/src/modules/core/components/loading-modal/index.tsx` | `frontend/src/modules/core/components/loading-modal/index.tsx` | adapted |
| `frontend/src/modules/core/components/modal/index.tsx` | `frontend/src/modules/core/components/confirm-modal/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/notice/index.tsx` | `frontend/src/modules/core/components/block-alert/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/org-avatar/index.tsx` | `frontend/src/modules/core/components/org-avatar/index.tsx` | adapted |
| `frontend/src/modules/core/components/page-header/index.tsx` | `frontend/src/modules/organization/pages/public-organizations-list/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/pagination/index.tsx` | `frontend/src/modules/pricing/components/pagination/index.tsx` | adapted |
| `frontend/src/modules/core/components/permanent-link/index.tsx` | `frontend/src/modules/core/components/permanent-link/index.tsx` | verbatim |
| `frontend/src/modules/core/components/pricing-renderer/index.tsx` | `frontend/src/modules/core/components/pricing-renderer/index.tsx` | adapted |
| `frontend/src/modules/core/components/pricing-renderer/source.ts` | `frontend/src/modules/core/components/pricing-renderer/source.ts` | adapted |
| `frontend/src/modules/core/components/pricing-renderer/tokens.ts` | `frontend/src/modules/core/components/pricing-renderer/tokens.ts` | adapted |
| `frontend/src/modules/core/components/problems-panel/index.tsx` | `frontend/src/modules/pricing-editor/components/problems-panel/index.tsx` | adapted |
| `frontend/src/modules/core/components/resource-card-shell/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | adapted |
| `frontend/src/modules/core/components/resource-list-view/index.tsx` | `frontend/src/modules/core/components/pricing-list-view/index.tsx` | adapted |
| `frontend/src/modules/core/components/router-link/index.tsx` | `frontend/src/modules/core/components/router-link/index.tsx` | adapted |
| `frontend/src/modules/core/components/search-input/index.tsx` | `frontend/src/modules/pricing/components/search-input/index.tsx` | adapted |
| `frontend/src/modules/core/components/select-field/index.tsx` | `frontend/src/modules/organization/pages/create-organization/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/skeleton-theme-provider/index.tsx` | `frontend/src/modules/core/components/skeleton-theme-provider/index.tsx` | adapted |
| `frontend/src/modules/core/components/skeleton/index.tsx` | `frontend/src/modules/core/components/skeletons/pricing-card-skeleton.tsx` | pattern-only |
| `frontend/src/modules/core/components/skeletons/collection-card-skeleton.tsx` | `frontend/src/modules/core/components/skeletons/collection-card-skeleton.tsx` | verbatim |
| `frontend/src/modules/core/components/skeletons/collections-list-skeleton.tsx` | `frontend/src/modules/core/components/skeletons/collections-list-skeleton.tsx` | verbatim |
| `frontend/src/modules/core/components/skeletons/dashboard-skeleton.tsx` | `frontend/src/modules/core/components/skeletons/dashboard-skeleton.tsx` | verbatim |
| `frontend/src/modules/core/components/skeletons/editor-skeleton.tsx` | `frontend/src/modules/core/components/skeletons/editor-skeleton.tsx` | verbatim |
| `frontend/src/modules/core/components/skeletons/org-detail-skeleton.tsx` | `frontend/src/modules/core/components/skeletons/org-detail-skeleton.tsx` | verbatim |
| `frontend/src/modules/core/components/skeletons/org-join-skeleton.tsx` | `frontend/src/modules/core/components/skeletons/org-join-skeleton.tsx` | verbatim |
| `frontend/src/modules/core/components/skeletons/org-list-skeleton.tsx` | `frontend/src/modules/core/components/skeletons/org-list-skeleton.tsx` | verbatim |
| `frontend/src/modules/core/components/skeletons/pricing-card-skeleton.tsx` | `frontend/src/modules/core/components/skeletons/pricing-card-skeleton.tsx` | verbatim |
| `frontend/src/modules/core/components/skeletons/pricing-list-skeleton.tsx` | `frontend/src/modules/core/components/skeletons/pricing-list-skeleton.tsx` | verbatim |
| `frontend/src/modules/core/components/slider-filter/index.tsx` | `frontend/src/modules/pricing/components/slider-filter/index.tsx` | adapted |
| `frontend/src/modules/core/components/slug-preview/index.tsx` | `frontend/src/modules/core/components/slug-preview/index.tsx` | verbatim |
| `frontend/src/modules/core/components/sunset-stripe/index.tsx` | `frontend/src/modules/core/components/sunset-stripe.tsx` | adapted |
| `frontend/src/modules/core/components/switch/index.tsx` | `frontend/src/modules/settings/components/beta-features-section.tsx` | pattern-only |
| `frontend/src/modules/core/components/tab-bar/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/modules/core/components/toast/index.tsx` | `frontend/src/modules/core/components/toast/index.tsx` | adapted |
| `frontend/src/modules/core/components/user-avatar/index.tsx` | `frontend/src/modules/core/components/user-avatar/index.tsx` | adapted (draws SCORETech Identity's descriptor) |
| `frontend/src/modules/core/contexts/toastContext.tsx` | `frontend/src/modules/core/contexts/toastContext.tsx` | adapted |
| `frontend/src/modules/core/contexts/useToast.ts` | `frontend/src/modules/core/contexts/useToast.ts` | verbatim |
| `frontend/src/modules/core/hooks/useQueryParams.ts` | `frontend/src/modules/core/hooks/useQueryParams.ts` | verbatim |
| `frontend/src/modules/core/hooks/useRecentItems.ts` | `frontend/src/modules/core/hooks/useRecentItems.ts` | adapted |
| `frontend/src/modules/core/hooks/useRouter.ts` | `frontend/src/modules/core/hooks/useRouter.ts` | adapted |
| `frontend/src/modules/core/hooks/useScrollToTop.ts` | `frontend/src/modules/core/hooks/useScrollToTop.ts` | verbatim |
| `frontend/src/modules/core/pages/loading/index.tsx` | `frontend/src/modules/core/pages/loading/index.tsx` | adapted |
| `frontend/src/modules/core/pages/page-not-found/index.tsx` | `frontend/src/modules/core/pages/page-not-found/index.tsx` | adapted |
| `frontend/src/modules/core/utils/custom-alert.tsx` | `frontend/src/modules/core/utils/custom-alert.tsx` | adapted |
| `frontend/src/modules/core/utils/custom-confirm.tsx` | `frontend/src/modules/core/utils/custom-confirm.tsx` | adapted |
| `frontend/src/modules/core/utils/generate-slug.ts` | `frontend/src/modules/core/utils/generate-slug.ts` | verbatim |
| `frontend/src/modules/core/utils/motion-variants.ts` | `frontend/src/modules/core/utils/motion-variants.ts` | verbatim |
| `frontend/src/modules/core/utils/offer-reload.ts` | `frontend/src/modules/pricing/pages/card/index.tsx` | adapted (extracted) |
| `frontend/src/modules/core/utils/recentItems.ts` | `frontend/src/modules/core/utils/recentItems.ts` | adapted |
| `frontend/src/modules/core/utils/sphere/graph.ts` | `frontend/src/modules/pricing/types/graph.ts` | verbatim |
| `frontend/src/modules/core/utils/sphere/selection-mapping.ts` | `frontend/src/modules/pricing/components/configuration-space-view/selection-mapping.ts` (feat/pricing-renderer) | verbatim |
| `frontend/src/modules/core/utils/sphere/version-graph.ts` | `frontend/src/modules/pricing/utils/version-graph.ts` | verbatim |
| `frontend/src/modules/core/utils/sphere/version-order.ts` | `frontend/src/modules/pricing/utils/version-order.ts` | verbatim |
| `frontend/src/modules/engine/api/enginesApi.ts` | `frontend/src/modules/api-keys/api/apiKeysApi.ts` | pattern-only |
| `frontend/src/modules/engine/components/engine-card/index.tsx` | `frontend/src/modules/pricing/components/pricing-card/index.tsx` | adapted |
| `frontend/src/modules/engine/components/get-engine-menu/index.tsx` | `frontend/src/modules/pricing/components/get-pricing-menu/index.tsx` | adapted |
| `frontend/src/modules/engine/components/my-deployments/index.tsx` | `frontend/src/modules/api-keys/components/ApiKeyList.tsx` | adapted |
| `frontend/src/modules/engine/pages/card/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | adapted |
| `frontend/src/modules/engine/pages/list/index.tsx` | `frontend/src/modules/pricing/pages/list/index.tsx` | adapted |
| `frontend/src/modules/engine/pages/my-engines/index.tsx` | `frontend/src/modules/api-keys/pages/ApiKeysPage.tsx` | adapted |
| `frontend/src/modules/engine/pages/register/index.tsx` | `frontend/src/modules/pricing/components/create-pricing-form/index.tsx` | adapted |
| `frontend/src/modules/engine/pages/registration/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | adapted |
| `frontend/src/modules/language/pages/language/index.tsx` | `frontend/src/modules/settings/pages/SettingsPage.tsx` | pattern-only |
| `frontend/src/modules/notification/api/notificationsApi.ts` | `frontend/src/modules/notification/api/notificationsApi.ts` | adapted |
| `frontend/src/modules/notification/components/notification-bell/index.tsx` | `frontend/src/modules/notification/components/notification-bell/index.tsx` | adapted |
| `frontend/src/modules/notification/components/notification-dropdown/index.tsx` | `frontend/src/modules/notification/components/notification-dropdown/index.tsx` | adapted |
| `frontend/src/modules/notification/components/notification-item/index.tsx` | `frontend/src/modules/notification/components/notification-item/index.tsx` | adapted |
| `frontend/src/modules/notification/components/notifications-sse-bridge/index.tsx` | `frontend/src/App.tsx` | pattern-only |
| `frontend/src/modules/notification/contexts/notificationsContext.ts` | `frontend/src/modules/notification/contexts/notificationsContext.tsx` | adapted |
| `frontend/src/modules/notification/contexts/notificationsProvider.tsx` | `frontend/src/modules/notification/contexts/notificationsContext.tsx` | adapted |
| `frontend/src/modules/notification/hooks/useNotificationsContext.ts` | `frontend/src/modules/notification/hooks/useNotificationsContext.ts` | verbatim |
| `frontend/src/modules/notification/hooks/useNotificationsSSE.ts` | `frontend/src/modules/notification/hooks/useNotificationsSSE.ts` | adapted |
| `frontend/src/modules/notification/pages/inbox/index.tsx` | `frontend/src/modules/notification/pages/inbox/index.tsx` | adapted |
| `frontend/src/modules/notification/utils/notification-link.ts` | `frontend/src/modules/notification/components/notification-item/index.tsx` | adapted |
| `frontend/src/modules/organization/api/connectionsApi.ts` | `frontend/src/modules/pricing/api/pricingsApi.ts` | pattern-only |
| `frontend/src/modules/organization/api/organizationsApi.ts` | `frontend/src/modules/organization/api/organizationsApi.ts` | adapted |
| `frontend/src/modules/organization/components/connections-tab/SphereKeyCard.tsx` | `frontend/src/modules/settings/components/IntegrationsSection.tsx` | adapted |
| `frontend/src/modules/organization/components/connections-tab/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/index.tsx` | pattern-only |
| `frontend/src/modules/organization/components/move-organization-modal/index.tsx` | `frontend/src/modules/organization/pages/organizations-list/index.tsx` | pattern-only |
| `frontend/src/modules/organization/components/org-dnd/index.tsx` | `frontend/src/modules/organization/components/org-dnd/index.tsx` | adapted |
| `frontend/src/modules/organization/components/org-dnd/row.ts` | `frontend/src/modules/organization/components/org-dnd/row.ts` | verbatim |
| `frontend/src/modules/organization/components/org-dnd/tree.ts` | `frontend/src/modules/organization/components/org-dnd/tree.ts` | verbatim |
| `frontend/src/modules/organization/components/organization-card/index.tsx` | `frontend/src/modules/organization/components/organization-card/index.tsx` (and, at `fc776b4d`, the Personal/Team chip) | adapted |
| `frontend/src/modules/organization/components/organization-selector/index.tsx` | `frontend/src/modules/pricing/components/organization-selector/index.tsx` | adapted |
| `frontend/src/modules/organization/components/role-badge/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/constants.ts` | adapted |
| `frontend/src/modules/organization/components/role-badge/roles.ts` | `frontend/src/modules/organization/pages/organization-detail/constants.ts` | adapted |
| `frontend/src/modules/organization/components/user-search-input/index.tsx` | `frontend/src/modules/organization/components/user-search-input/index.tsx` | adapted |
| `frontend/src/modules/organization/contexts/organizationContext.ts` | `frontend/src/modules/organization/contexts/organizationContext.ts` | adapted |
| `frontend/src/modules/organization/hooks/useOrgReparenting.ts` | `frontend/src/modules/organization/hooks/useOrgReparenting.ts` | adapted |
| `frontend/src/modules/organization/hooks/useOrganization.ts` | `frontend/src/modules/organization/hooks/useOrganization.ts` | adapted |
| `frontend/src/modules/organization/pages/create-organization/index.tsx` | `frontend/src/modules/organization/pages/create-organization/index.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/AddMemberModal.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/AddMemberModal.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/ChildRolesManager.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/ChildRolesManager.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/CreateSubOrgModal.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/CreateSubOrgModal.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/EditOrgModal.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/EditOrgModal.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/HierarchyTab.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/HierarchyTab.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/InvitationsTab.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/InvitationsTab.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/InviteModal.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/InviteModal.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/MembersTab.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/MembersTab.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/OrgAvatarModal.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/OrgAvatarModal.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/OrgTreeNode.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/OrgTreeNode.tsx` (and, at `fc776b4d`, the personal organization that is never dragged) | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/OrganizationExitButton.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/OrganizationExitButton.tsx` (and, at `fc776b4d`, nothing for a personal organization's owner) | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/OverviewTab.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/OverviewTab.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/components/ShareOrgMenu.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/ShareOrgMenu.tsx` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/constants.ts` | `frontend/src/modules/organization/pages/organization-detail/constants.ts` | adapted |
| `frontend/src/modules/organization/pages/organization-detail/hooks.ts` | `frontend/src/modules/organization/pages/organization-detail/hooks.ts` | verbatim |
| `frontend/src/modules/organization/pages/organization-detail/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/index.tsx` (and, at `fc776b4d`, `isPersonal` on the tree) | adapted |
| `frontend/src/modules/organization/pages/organization-detail/types.ts` | `frontend/src/modules/organization/pages/organization-detail/types.ts` (and, at `fc776b4d`, `isPersonal`) | adapted |
| `frontend/src/modules/organization/pages/organization-join/index.tsx` | `frontend/src/modules/organization/pages/organization-join/index.tsx` | adapted |
| `frontend/src/modules/organization/pages/organizations-list/index.tsx` | `frontend/src/modules/organization/pages/organizations-list/index.tsx` (and, at `fc776b4d`, the Personal and Teams sections and the immovable personal organization) | adapted |
| `frontend/src/modules/organization/pages/public-organizations-list/index.tsx` | `frontend/src/modules/organization/pages/public-organizations-list/index.tsx` | adapted |
| `frontend/src/modules/organization/utils/filter-tree.ts` | `frontend/src/modules/organization/pages/organizations-list/index.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/app-footer.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/app-footer.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/app-header.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/app-header.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/index.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/index.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/mobile-nav.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/mobile-nav.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/user-menu.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/user-menu.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/components/contribution-card/index.tsx` | `frontend/src/modules/presentation/layouts/components/contribution-card/index.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/components/contribution-details/index.tsx` | `frontend/src/modules/presentation/layouts/components/contribution-details/index.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/components/team-member-card/index.tsx` | `frontend/src/modules/presentation/layouts/components/team-member-card/index.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/public-layout/index.tsx` | `frontend/src/modules/presentation/layouts/public-layout/index.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/router/header-routes.ts` | `frontend/src/modules/presentation/layouts/router/header-routes.ts` | adapted |
| `frontend/src/modules/presentation/pages/changelog/components/changelog.tsx` | `frontend/src/modules/presentation/pages/changelog/components/changelog.tsx` | adapted |
| `frontend/src/modules/presentation/pages/changelog/components/release-changes.tsx` | `frontend/src/modules/presentation/pages/changelog/components/release-changes.tsx` | adapted |
| `frontend/src/modules/presentation/pages/changelog/components/release-content.tsx` | `frontend/src/modules/presentation/pages/changelog/components/release-content.tsx` | adapted |
| `frontend/src/modules/presentation/pages/changelog/components/release-version.tsx` | `frontend/src/modules/presentation/pages/changelog/components/release-version.tsx` | adapted |
| `frontend/src/modules/presentation/pages/changelog/index.tsx` | `frontend/src/modules/presentation/pages/changelog/index.tsx` | adapted |
| `frontend/src/modules/presentation/pages/changelog/types.ts` | `frontend/src/modules/presentation/pages/changelog/types.ts` | adapted |
| `frontend/src/modules/presentation/pages/contributions/index.tsx` | `frontend/src/modules/presentation/pages/contributions/index.tsx` | adapted |
| `frontend/src/modules/presentation/pages/dashboard/index.tsx` | `frontend/src/modules/presentation/pages/dashboard/index.tsx` | adapted |
| `frontend/src/modules/presentation/pages/home/components/background-orbs.tsx` | `frontend/src/modules/presentation/pages/home/components/background-orbs.tsx` | adapted |
| `frontend/src/modules/presentation/pages/home/components/call-to-action.tsx` | `frontend/src/modules/presentation/pages/home/components/call-to-action.tsx` | adapted |
| `frontend/src/modules/presentation/pages/home/components/floating-morph-header.tsx` | `frontend/src/modules/presentation/pages/home/components/floating-morph-header.tsx` | adapted |
| `frontend/src/modules/presentation/pages/home/components/island-button.tsx` | `frontend/src/modules/presentation/pages/home/components/island-button.tsx` | adapted |
| `frontend/src/modules/presentation/pages/home/components/reveal-block.tsx` | `frontend/src/modules/presentation/pages/home/components/reveal-block.tsx` | adapted |
| `frontend/src/modules/presentation/pages/home/index.tsx` | `frontend/src/modules/presentation/pages/home/index.tsx` | adapted |
| `frontend/src/modules/presentation/pages/pricing/index.tsx` | `frontend/src/modules/presentation/pages/pricing/index.tsx` | adapted |
| `frontend/src/modules/presentation/pages/research/components/timeline.tsx` | `frontend/src/modules/presentation/pages/research/components/timeline.tsx` | adapted |
| `frontend/src/modules/presentation/pages/research/index.tsx` | `frontend/src/modules/presentation/pages/research/index.tsx` | adapted |
| `frontend/src/modules/presentation/pages/root/index.tsx` | `frontend/src/routes/router.tsx` | pattern-only |
| `frontend/src/modules/presentation/pages/team/index.tsx` | `frontend/src/modules/presentation/pages/team/index.tsx` | adapted |
| `frontend/src/modules/problem-editor/components/code-pane/index.tsx` | `frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/index.tsx` | pattern-only |
| `frontend/src/modules/problem-editor/components/open-modal/index.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx` | pattern-only |
| `frontend/src/modules/problem-editor/components/save-modal/index.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx` | adapted |
| `frontend/src/modules/problem-editor/contexts/problemEditorContext.ts` | `frontend/src/modules/pricing-editor/contexts/editorValueContext.ts` | adapted |
| `frontend/src/modules/problem-editor/hooks/useProblemEditorValue.ts` | `frontend/src/modules/pricing-editor/hooks/useEditorValue.ts` | adapted |
| `frontend/src/modules/problem-editor/layouts/editor-layout/editor-header.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/editor-header.tsx` | adapted |
| `frontend/src/modules/problem-editor/layouts/editor-layout/index.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/index.tsx` | adapted |
| `frontend/src/modules/problem-editor/pages/problem-editor/index.tsx` | `frontend/src/modules/pricing-editor/pages/pricing2yaml-editor/index.tsx` | adapted |
| `frontend/src/modules/problem-editor/services/export.ts` | `frontend/src/modules/pricing-editor/services/export.service.ts` | adapted |
| `frontend/src/modules/problem/api/problemsApi.ts` | `frontend/src/modules/pricing/api/pricingsApi.ts` | pattern-only |
| `frontend/src/modules/problem/api/sphereApi.ts` | `frontend/src/modules/pricing/api/pricingsApi.ts` | pattern-only |
| `frontend/src/modules/problem/components/candidates-explorer/index.tsx` | `frontend/src/modules/pricing/components/configuration-space-view/index.tsx` | adapted |
| `frontend/src/modules/problem/components/compositions-tab/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/PricingsTab.tsx` | pattern-only |
| `frontend/src/modules/problem/components/delete-problem-modal/index.tsx` | `frontend/src/modules/pricing/components/pricing-settings-tab/index.tsx` | pattern-only |
| `frontend/src/modules/problem/components/get-problem-menu/index.tsx` | `frontend/src/modules/pricing/components/get-pricing-menu/index.tsx` | adapted |
| `frontend/src/modules/problem/components/new-version-menu/index.tsx` | `frontend/src/modules/pricing/components/new-version-menu/index.tsx` | adapted |
| `frontend/src/modules/problem/components/overview-tab/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/modules/problem/components/problem-card/index.tsx` | `frontend/src/modules/pricing/components/pricing-card/index.tsx` | adapted |
| `frontend/src/modules/problem/components/problem-import-modal/index.tsx` | `frontend/src/modules/pricing/components/pricing-import-modal/index.tsx` | adapted |
| `frontend/src/modules/problem/components/problems-tab/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/PricingsTab.tsx` | adapted |
| `frontend/src/modules/problem/components/runs-tab/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/modules/problem/components/settings-tab/index.tsx` | `frontend/src/modules/pricing/components/pricing-settings-tab/index.tsx` | adapted |
| `frontend/src/modules/problem/components/source-tab/index.tsx` | `frontend/src/modules/pricing/components/yaml-source-panel/index.tsx` | pattern-only |
| `frontend/src/modules/problem/components/sphere-candidates-modal/index.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx` | adapted |
| `frontend/src/modules/problem/components/sphere-candidates-modal/plan-picker.tsx` | `frontend/src/modules/pricing/components/configuration-space-view/configuration-picker.tsx` (feat/pricing-renderer) | adapted |
| `frontend/src/modules/problem/components/sphere-candidates-modal/pricing-search.tsx` | `frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx` | adapted |
| `frontend/src/modules/problem/components/versions-tab/index.tsx` | `frontend/src/modules/pricing/components/pricing-versions-tab/index.tsx` | adapted |
| `frontend/src/modules/problem/components/versions-tab/version-compare.tsx` | `frontend/src/modules/pricing/components/pricing-version-diff/index.tsx` | adapted |
| `frontend/src/modules/problem/pages/card/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | adapted |
| `frontend/src/modules/run/api/runsApi.ts` | `frontend/src/modules/pricing/api/pricingsApi.ts` | pattern-only |
| `frontend/src/modules/run/components/derive/DeriveBatch.tsx` | `frontend/src/modules/pricing/components/fork-pricing-modal/index.tsx` | pattern-only |
| `frontend/src/modules/run/components/derive/DeriveCompositionDialog.tsx` | `frontend/src/modules/pricing/components/fork-pricing-modal/index.tsx` | pattern-only |
| `frontend/src/modules/run/components/get-run-menu/index.tsx` | `frontend/src/modules/pricing/components/get-pricing-menu/index.tsx` | adapted |
| `frontend/src/modules/run/components/launch-steps/index.tsx` | `frontend/src/modules/pricing/components/create-pricing-form/index.tsx` | pattern-only |
| `frontend/src/modules/run/components/preset-picker/index.tsx` | `frontend/src/modules/pricing/components/create-pricing-form/index.tsx` | pattern-only |
| `frontend/src/modules/run/components/run-facts/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/modules/run/components/run-outcome/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/modules/run/components/run-row/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/MembersTab.tsx` | pattern-only |
| `frontend/src/modules/run/components/run-status/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/constants.ts` | pattern-only |
| `frontend/src/modules/run/components/runs-tab/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/PricingsTab.tsx` | adapted |
| `frontend/src/modules/run/pages/card/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | adapted |
| `frontend/src/modules/run/pages/create/index.tsx` | `frontend/src/modules/pricing/pages/create/index.tsx` | adapted |
| `frontend/src/modules/settings/api/userSettingsApi.ts` | `frontend/src/modules/settings/api/userSettingsApi.ts` | adapted |
| `frontend/src/modules/settings/components/AccountSection.tsx` | `frontend/src/modules/settings/components/AccountSection.tsx` | adapted |
| `frontend/src/modules/settings/components/AppearanceSection.tsx` | `frontend/src/modules/settings/components/NotificationsSection.tsx` | pattern-only |
| `frontend/src/modules/settings/components/AvatarEditor.tsx` | `frontend/src/modules/settings/components/AvatarEditor.tsx` | adapted (SCORETech Identity's descriptor shapes; no upload or crop) |
| `frontend/src/modules/settings/components/BetaFeaturesSection.tsx` | `frontend/src/modules/settings/components/BetaFeaturesSection.tsx` | adapted |
| `frontend/src/modules/settings/components/DangerZoneSection.tsx` | `frontend/src/modules/settings/components/DangerZoneSection.tsx` | adapted |
| `frontend/src/modules/settings/components/IdentityAccountSection.tsx` | `frontend/src/modules/settings/components/IdentityAccountSection.tsx` | adapted (without the `linking` variant) |
| `frontend/src/modules/settings/components/NotificationsSection.tsx` | `frontend/src/modules/settings/components/NotificationsSection.tsx` | adapted |
| `frontend/src/modules/settings/components/PlanSection.tsx` | `frontend/src/modules/settings/components/PaymentsSection.tsx` | adapted |
| `frontend/src/modules/settings/components/PublicProfileSection.tsx` | `frontend/src/modules/settings/components/PublicProfileSection.tsx` | adapted (the display name and the avatar only) |
| `frontend/src/modules/settings/components/SaveButton.tsx` | `frontend/src/modules/settings/components/AccountSection.tsx` | adapted (extracted) |
| `frontend/src/modules/settings/components/UnsavedChangesDialog.tsx` | `frontend/src/modules/settings/components/UnsavedChangesDialog.tsx` | adapted |
| `frontend/src/modules/settings/pages/settings-page/index.tsx` | `frontend/src/modules/settings/pages/SettingsPage.tsx` | adapted |
| `frontend/src/modules/settings/pages/settings-page/sections.ts` | `frontend/src/modules/settings/pages/SettingsPage.tsx` | adapted (extracted) |
| `frontend/src/modules/settings/utils/useSavedFlash.ts` | `frontend/src/modules/settings/components/AccountSection.tsx` | pattern-only |
| `frontend/src/modules/study/api/studiesApi.ts` | `frontend/src/modules/profile/api/pricingCollectionsApi.ts` | pattern-only |
| `frontend/src/modules/study/components/builder-fields/index.tsx` | `frontend/src/modules/profile/components/pricings-selector/index.tsx` | adapted |
| `frontend/src/modules/study/components/cell-sheet/index.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/modules/study/components/create-study-form/index.tsx` | `frontend/src/modules/profile/components/create-collection-form/index.tsx` | adapted |
| `frontend/src/modules/study/components/front-comparison/index.tsx` | `frontend/src/modules/pricing/components/configuration-space-view/configuration-comparison.tsx` | pattern-only |
| `frontend/src/modules/study/components/get-study-menu/index.tsx` | `frontend/src/modules/pricing/components/get-pricing-menu/index.tsx` | adapted |
| `frontend/src/modules/study/components/pareto-front/index.tsx` | `frontend/src/modules/pricing/components/configuration-space-view/index.tsx` | adapted |
| `frontend/src/modules/study/components/results/charts.tsx` | `frontend/src/modules/pricing/components/pricing-analytics-tab/index.tsx` | adapted |
| `frontend/src/modules/study/components/results/index.tsx` | `frontend/src/modules/pricing/pages/collection-card/index.tsx` | adapted |
| `frontend/src/modules/study/components/selectable-version-card/index.tsx` | `frontend/src/modules/profile/components/selectable-pricing-card/index.tsx` | adapted |
| `frontend/src/modules/study/components/setup-tab/index.tsx` | `frontend/src/modules/pricing/pages/collection-card/index.tsx` | pattern-only |
| `frontend/src/modules/study/components/studies-tab/index.tsx` | `frontend/src/modules/organization/pages/organization-detail/components/CollectionsTab.tsx` | adapted |
| `frontend/src/modules/study/components/study-card/index.tsx` | `frontend/src/modules/pricing/components/collection-card/index.tsx` | adapted |
| `frontend/src/modules/study/components/study-run/index.tsx` | `frontend/src/modules/pricing/pages/collection-card/index.tsx` | pattern-only |
| `frontend/src/modules/study/components/study-settings/index.tsx` | `frontend/src/modules/pricing/components/collection-settings/index.tsx` | adapted |
| `frontend/src/modules/study/pages/card/index.tsx` | `frontend/src/modules/pricing/pages/collection-card/index.tsx` | adapted |
| `frontend/src/modules/study/pages/create/index.tsx` | `frontend/src/modules/profile/pages/create-collection/index.tsx` | adapted |
| `frontend/src/routes/app-layout.tsx` | `frontend/src/routes/app-layout.tsx` | adapted |
| `frontend/src/routes/router.tsx` | `frontend/src/routes/router.tsx` | pattern-only |
| `frontend/src/styles/tailwind.css` | `frontend/src/styles/tailwind.css` | adapted |
| `frontend/test/version-graph.test.ts` | `frontend/test/version-graph.test.ts` | verbatim |
| `frontend/vite.config.ts` | `frontend/vite.config.ts` | pattern-only |

<!-- sphere-convergence:end -->

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
