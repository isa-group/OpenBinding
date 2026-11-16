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
| [react-easy-crop](https://github.com/ValentinH/react-easy-crop) | `5.5.7` | MIT | Cropping avatars |
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
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/application/graph.py` | `api/src/main/services/PricingService.ts` (`graph`, `_graphLane`, `_unavailableSourceLane`, `GRAPH_MAX_LANES`) (adapted: composition lanes; no unavailable lane, and no edge to it, for a reader who is not a member) |
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/application/follows.py` | `api/src/main/services/PricingFollowService.ts` (adapted: a reader of the composition follows it; a new version tells every follower who still reads it, skipping the author) |
| `openbinding-gateway/src/openbinding_gateway/modules/compositions/adapters/link_routes.py` | `api/src/main/routes/PermanentLinkRoutes.ts`, `api/src/main/services/PermanentLinkService.ts` (`resolve`, `archiveName`) and `api/src/main/routes/PricingFollowRoutes.ts` (adapted: the ETag, `Vary` and the one 404 kept; `private, no-store` for every caller; a version named by id or label) |

<!-- sphere-convergence:start -->

The frontend files of the move to SPHERE's frontend (`docs/adr/0053-frontend-on-sphere-stack.md`), at revision
`73779a8a`, each with its reuse class: **verbatim** (copied; only imports, wording and types changed), **adapted**
(copied, with logic changed; the header says what) or **pattern-only** (the layout followed, the code written here).
Generated from the origin header of each file.

| File | SPHERE origin | Class |
|---|---|---|
| `frontend/src/features/composition-editor/UploadDialog.tsx` | `frontend/src/modules/pricing/components/pricing-import-modal/index.tsx` | pattern-only |
| `frontend/src/features/fork/ForkCompositionDialog.tsx` | `frontend/src/modules/pricing/components/fork-pricing-modal/index.tsx` | pattern-only |
| `frontend/src/modules/beta/components/beta-badge/index.tsx` | `frontend/src/modules/beta/components/beta-badge/index.tsx` | verbatim |
| `frontend/src/modules/beta/components/beta-gate/index.tsx` | `frontend/src/modules/beta/components/beta-gate/index.tsx` | verbatim |
| `frontend/src/modules/beta/config/betaFeatures.ts` | `frontend/src/modules/beta/config/betaFeatures.ts` | adapted |
| `frontend/src/modules/beta/hooks/useBetaFeatures.ts` | `frontend/src/modules/beta/hooks/useBetaFeatures.ts` | adapted |
| `frontend/src/modules/core/components/404-logo/index.tsx` | `frontend/src/modules/core/components/404-logo/index.tsx` | adapted |
| `frontend/src/modules/core/components/action-button/index.tsx` | `frontend/src/modules/core/components/action-button/index.tsx` | adapted |
| `frontend/src/modules/core/components/alert-modal/index.tsx` | `frontend/src/modules/core/components/alert-modal/index.tsx` | adapted |
| `frontend/src/modules/core/components/alerts/index.tsx` | `frontend/src/modules/core/components/alerts/index.tsx` | adapted |
| `frontend/src/modules/core/components/block-alert/index.tsx` | `frontend/src/modules/core/components/block-alert/index.tsx` | verbatim |
| `frontend/src/modules/core/components/command-palette/index.tsx` | `frontend/src/modules/core/components/command-palette/index.tsx` | adapted |
| `frontend/src/modules/core/components/confirm-modal/index.tsx` | `frontend/src/modules/core/components/confirm-modal/index.tsx` | adapted |
| `frontend/src/modules/core/components/copy-icon/index.tsx` | `frontend/src/modules/core/components/copy-icon/index.tsx` | adapted |
| `frontend/src/modules/core/components/date-picker/index.tsx` | `frontend/src/modules/core/components/date-picker/index.tsx` | adapted |
| `frontend/src/modules/core/components/dual-range-slider/index.tsx` | `frontend/src/modules/pricing/components/dual-range-slider/index.tsx` | verbatim |
| `frontend/src/modules/core/components/error-boundary/index.tsx` | `frontend/src/modules/core/components/error-boundary/index.tsx` | adapted |
| `frontend/src/modules/core/components/file-upload-input/index.tsx` | `frontend/src/modules/core/components/file-upload-input/index.tsx` | adapted |
| `frontend/src/modules/core/components/filter-bar/index.tsx` | `frontend/src/modules/pricing/components/filter-bar/index.tsx` | adapted |
| `frontend/src/modules/core/components/iconify/index.tsx` | `frontend/src/modules/core/components/iconify/index.tsx` | adapted |
| `frontend/src/modules/core/components/loaders/banter-loader/index.tsx` | `frontend/src/modules/core/components/loaders/banter-loader/index.tsx` | verbatim |
| `frontend/src/modules/core/components/loading-modal/index.tsx` | `frontend/src/modules/core/components/loading-modal/index.tsx` | adapted |
| `frontend/src/modules/core/components/org-avatar/index.tsx` | `frontend/src/modules/core/components/org-avatar/index.tsx` | adapted |
| `frontend/src/modules/core/components/pagination/index.tsx` | `frontend/src/modules/pricing/components/pagination/index.tsx` | adapted |
| `frontend/src/modules/core/components/permanent-link/index.tsx` | `frontend/src/modules/core/components/permanent-link/index.tsx` | verbatim |
| `frontend/src/modules/core/components/router-link/index.tsx` | `frontend/src/modules/core/components/router-link/index.tsx` | adapted |
| `frontend/src/modules/core/components/search-input/index.tsx` | `frontend/src/modules/pricing/components/search-input/index.tsx` | verbatim |
| `frontend/src/modules/core/components/skeleton-theme-provider/index.tsx` | `frontend/src/modules/core/components/skeleton-theme-provider/index.tsx` | adapted |
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
| `frontend/src/modules/core/components/toast/index.tsx` | `frontend/src/modules/core/components/toast/index.tsx` | adapted |
| `frontend/src/modules/core/components/user-avatar/index.tsx` | `frontend/src/modules/core/components/user-avatar/index.tsx` | adapted |
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
| `frontend/src/modules/organization/contexts/organizationContext.ts` | `frontend/src/modules/organization/contexts/organizationContext.ts` | adapted |
| `frontend/src/modules/organization/hooks/useOrganization.ts` | `frontend/src/modules/organization/hooks/useOrganization.ts` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/app-footer.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/app-footer.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/app-header.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/app-header.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/index.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/index.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/mobile-nav.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/mobile-nav.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/authenticated-layout/user-menu.tsx` | `frontend/src/modules/presentation/layouts/authenticated-layout/user-menu.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/public-layout/index.tsx` | `frontend/src/modules/presentation/layouts/public-layout/index.tsx` | adapted |
| `frontend/src/modules/presentation/layouts/router/header-routes.ts` | `frontend/src/modules/presentation/layouts/router/header-routes.ts` | adapted |
| `frontend/src/modules/presentation/pages/home/components/floating-morph-header.tsx` | `frontend/src/modules/presentation/pages/home/components/floating-morph-header.tsx` | adapted |
| `frontend/src/pages/Compositions/CompositionDetail.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/pages/Compositions/tabs/VersionsTab.tsx` | `frontend/src/modules/pricing/components/pricing-versions-tab/index.tsx` | pattern-only |
| `frontend/src/pages/PublicCompositions/PublicCompositionList.tsx` | `frontend/src/modules/pricing/pages/list/index.tsx` | pattern-only |
| `frontend/src/pages/PublicCompositions/Showcase.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/pages/Studies/ParetoFront.tsx` | `frontend/src/modules/pricing/components/configuration-space-view/index.tsx` | pattern-only |
| `frontend/src/routes/app-layout.tsx` | `frontend/src/routes/app-layout.tsx` | adapted |
| `frontend/src/routes/router.tsx` | `frontend/src/routes/router.tsx` | pattern-only |
| `frontend/src/styles/tailwind.css` | `frontend/src/styles/tailwind.css` | adapted |
| `frontend/src/widgets/change-summary/ChangeSummary.tsx` | `frontend/src/modules/pricing/components/pricing-version-graph/change-summary-card.tsx` | pattern-only |
| `frontend/src/widgets/composition-renderer/modes/calculator.tsx` | `frontend/src/modules/pricing/components/configuration-space-view/index.tsx` | pattern-only |
| `frontend/src/widgets/composition-renderer/modes/comparison/Comparison.tsx` | `frontend/src/modules/pricing/components/pricing-version-diff/index.tsx` | pattern-only |
| `frontend/src/widgets/composition-renderer/modes/comparison/FileDiff.tsx` | `frontend/src/modules/pricing/components/pricing-version-diff/file-diff-view.tsx` | pattern-only |
| `frontend/src/widgets/composition-renderer/modes/showcase.tsx` | `frontend/src/modules/pricing/pages/card/index.tsx` | pattern-only |
| `frontend/src/widgets/evolution-charts/EvolutionCharts.tsx` | `frontend/src/modules/pricing/components/pricing-analytics-tab/index.tsx` | pattern-only |
| `frontend/src/widgets/problems-panel/ProblemsPanel.tsx` | `frontend/src/modules/pricing-editor/components/problems-panel/index.tsx` | pattern-only |
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
