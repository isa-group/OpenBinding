# Galería de QA visual

Una captura de la primera pantalla de **cada una de las 86 rutas** del registro (`frontend/src/routes/d1.tsx` … `d8.tsx`),
en escritorio (1440×900, escala 1) y en móvil (390×844, escala 2). Sirve para que el responsable valide el aspecto sin
levantar el backend.

> **Aviso de actualidad.** Esta galería es un registro de capturas. Las filas `admin-routing`, `admin-pricing`, `admin-pricing-draft` y `admin-pricing-release` corresponden a pantallas retiradas (la selección automática de motores y la gestión de pricing; el pricing se administra ahora en las consolas remotas de SPHERE/SPACE) y ya no tienen ruta en `frontend/src/routes`; sus capturas son **históricas**. `acct-usage` sigue teniendo ruta, pero la plataforma ya no mide ni cobra consumo. El número de rutas (86) y las cifras de «Última regeneración» no se han vuelto a comprobar tras esa retirada.

## Última regeneración

2026-10-10: la galería se regeneró (desktop y mobile). Verificación final de esta rama: gateway 1209 tests ok
(8 omitidos, 2 xfail); vitest 177 ficheros / 2486 tests; build ok; e2e s1a..s9b, visual, pricing/analysis/f2 y
routes-smoke 87 ok (dos flakes de carga que pasaron al repetir: s5d-workbench desktop y f2-ranges).

## Cómo regenerarla

Desde `frontend/` (el servidor de desarrollo de Vite lo arranca Playwright). Se regenera un viewport por comando; cada
uno tarda unos 3 minutos, por eso se lanzan por separado:

```bash
# escritorio: docs/frontend-qa/screenshots/desktop/<id>.png (86 ficheros)
E2E_SCREENSHOTS=1 pnpm exec playwright test e2e/qa-gallery.spec.ts --grep 'desktop' --reporter=line

# móvil: docs/frontend-qa/screenshots/mobile/<id>.png (86 ficheros)
E2E_SCREENSHOTS=1 pnpm exec playwright test e2e/qa-gallery.spec.ts --grep 'mobile' --reporter=line
```

Sin `--grep` se generan ambos viewports seguidos. `qa-gallery.spec.ts` escribe sus capturas siempre; `E2E_SCREENSHOTS=1`
es lo que activa las capturas de estados de los specs `s*.spec.ts` y `pricing.spec.ts` (que van a `test-results/`, fuera
del repositorio) y se mantiene en los comandos para que una pasada de galería deje todo el material de revisión
coherente. Sin la variable esos specs siguen comprobando que nada desborda en horizontal, pero no escriben imágenes.
`e2e/routes-smoke.spec.ts` recorre las 86 rutas en un solo worker (≈ 1,5 min); con `VITE_ROUTES_REQUIRE_LIVE=1` exige
que cada ruta cargue su pantalla real:

```bash
VITE_ROUTES_REQUIRE_LIVE=1 pnpm exec playwright test e2e/routes-smoke.spec.ts --reporter=line
```

Cada captura es del viewport (no `fullPage`) y se hace con el scroll arriba, sin foco y con animaciones desactivadas.
Tras regenerar, todas las capturas deben salir de la misma versión del código: no mezcles ficheros de pasadas distintas.

## Cómo está hecha

- `frontend/e2e/qa-gallery.spec.ts`: un test por ruta y viewport. Lee el registro del código fuente, sustituye los
  parámetros por valores de ejemplo (`e2e/helpers/galleryRoutes.ts`), espera a un `h1` concreto de cada pantalla y a que
  desaparezcan esqueletos, `aria-busy` y cargadores, y solo entonces captura. Falla si hay una excepción de React, un
  desbordamiento horizontal, un diálogo/banner superpuesto, una petición sin respuesta en el mock o el texto
  «This screen is being rebuilt».
- `frontend/e2e/helpers/mockApi.ts`: un único mock compartido de la API (`page.route`). Reutiliza los fixtures de
  `src/test/fixtures/` (en inglés y con personas neutras: `alex.rivera`, `maria.santos`, `sam.okafor`…; los fixtures
  que se quedan en `src/pages/` no nombran a nadie) y los de `src/pages/*/` que no tienen personas. `src/hygiene.test.ts`
  vigila que no vuelvan las personas del prototipo ni texto en español en ellos. La sesión es la de un
  **administrador de plataforma con cuenta institucional** (plan RESEARCH, `institutional_branding`), con la organización
  `isa-demo`, el proyecto `qos-benchmarks`, casos, revisiones, ejecuciones, un estudio con su run y celdas, informes,
  publicaciones, biblioteca, ficheros, colecciones, motores y datos de administración.
- Rutas públicas (`/`, `/explore`, `/login`, `/pricing`…): **sin sesión**. Rutas bajo `/app` y el enlace de invitación
  (`/invitations/accept`, que el router sirve con la cabecera de aplicación si hay sesión): con sesión.
- `frontend/e2e/helpers/pageChecks.ts` mide cada página (desbordes, texto cortado, contraste, idioma, restos del
  prototipo, tema oscuro, marca institucional, pestañas de proyecto). Las mediciones se escriben en
  `frontend/node_modules/.cache/qa-gallery/` y **no** forman parte del repositorio.

### Determinismo

- Todas las páginas creen que son el 2026-10-09 12:00 UTC (`page.clock.setFixedTime`); `locale: en-US`, zona UTC.
- Fechas e identificadores de los fixtures son fijos. Los milisegundos que mide `/status` con el reloj del navegador se
  sustituyen por «120 ms» antes de capturar.
- Los enlaces absolutos de publicaciones muestran el origen del servidor de pruebas (`http://127.0.0.1:4177`).
### Tipografía

- La pila de titulares es `--font-display: 'PP Editorial Old', Georgia, serif` (`src/styles/globals.css`). **No hay
  archivo de PP Editorial Old** (ni licencia todavía): solo se declara en la pila, de modo que el navegador usa el
  siguiente tipo disponible, **Georgia**, y si no existe, la serif genérica del sistema. Es una decisión de la persona
  responsable hasta tener archivos legítimos.
- **Las capturas de este entorno Linux no tienen Georgia**: los titulares con `--font-display` (p. ej. «Welcome back»,
  «Pricing», «Workbench») se ven en la serif genérica del sistema. Es lo esperado; en equipos con Georgia
  saldrán en Georgia. El titular de la portada (`pub-home`) usa deliberadamente la sans del cuerpo.
- `Times New Roman` no forma parte de la pila, aunque `tokens.json` (referencia importada de `docs/design-handoff`, que
  no se toca) todavía la nombre. `src/hygiene.test.ts` falla si `Times New Roman` aparece antes de Georgia en
  `--font-display`.

## Pantallas y capturas

Parámetros de ejemplo: `:org` = `isa-demo`, `:project` = `qos-benchmarks`, `:case` = `checkout-flow`, `:revision` = `2`,
`:artifact` = `providers-eu`, `:draft` = `draft-providers-4`, `:resource` = `latency-probes`, `:collection` =
`checkout-references`, `:study` = `engines-vs-seeds`, `:run` = `…0101`, `:cell` = `…0202`, `:job` = `…00a1`,
`:report` = `engine-comparison`, `:version` = `3` (biblioteca) / `0.1.0` (precios) / `1.0.0` (motor), `:user` = la cuenta
`sam.okafor`. Algunas pantallas necesitan además una *query* para mostrar contenido (`?case=…&revision=2`, `?job=…&job=…`,
`?digest=…`, `?namespace=…&version=…&digest=…`, `?token=…`); la URL exacta visitada está en `e2e/helpers/galleryRoutes.ts`.

| id | ruta | escritorio | móvil |
| --- | --- | --- | --- |
| `pub-home` | `/` | [png](screenshots/desktop/pub-home.png) | [png](screenshots/mobile/pub-home.png) |
| `pub-explore` | `/explore` | [png](screenshots/desktop/pub-explore.png) | [png](screenshots/mobile/pub-explore.png) |
| `pub-resolve` | `/resolve/:kind/:digest` | [png](screenshots/desktop/pub-resolve.png) | [png](screenshots/mobile/pub-resolve.png) |
| `eng-catalog` | `/engines` | [png](screenshots/desktop/eng-catalog.png) | [png](screenshots/mobile/eng-catalog.png) |
| `eng-detail` | `/engines/:namespace/:name/:version` | [png](screenshots/desktop/eng-detail.png) | [png](screenshots/mobile/eng-detail.png) |
| `lang-profiles` | `/language` | [png](screenshots/desktop/lang-profiles.png) | [png](screenshots/mobile/lang-profiles.png) |
| `lang-schemas` | `/language/schemas/:kind` | [png](screenshots/desktop/lang-schemas.png) | [png](screenshots/mobile/lang-schemas.png) |
| `lang-examples` | `/examples` | [png](screenshots/desktop/lang-examples.png) | [png](screenshots/mobile/lang-examples.png) |
| `pub-workbench` | `/workbench` | [png](screenshots/desktop/pub-workbench.png) | [png](screenshots/mobile/pub-workbench.png) |
| `pub-about` | `/about` | [png](screenshots/desktop/pub-about.png) | [png](screenshots/mobile/pub-about.png) |
| `pub-status` | `/status` | [png](screenshots/desktop/pub-status.png) | [png](screenshots/mobile/pub-status.png) |
| `auth-login` | `/login` | [png](screenshots/desktop/auth-login.png) | [png](screenshots/mobile/auth-login.png) |
| `auth-register` | `/register` | [png](screenshots/desktop/auth-register.png) | [png](screenshots/mobile/auth-register.png) |
| `auth-reset-request` | `/password-reset` | [png](screenshots/desktop/auth-reset-request.png) | [png](screenshots/mobile/auth-reset-request.png) |
| `auth-reset-complete` | `/password-reset/complete` | [png](screenshots/desktop/auth-reset-complete.png) | [png](screenshots/mobile/auth-reset-complete.png) |
| `auth-cas-callback` | `/auth/cas/callback` | [png](screenshots/desktop/auth-cas-callback.png) | [png](screenshots/mobile/auth-cas-callback.png) |
| `org-invite-accept` | `/invitations/accept` | [png](screenshots/desktop/org-invite-accept.png) | [png](screenshots/mobile/org-invite-accept.png) |
| `sys-states` | `/app/system/states` | [png](screenshots/desktop/sys-states.png) | [png](screenshots/mobile/sys-states.png) |
| `pub-pricing` | `/pricing` | [png](screenshots/desktop/pub-pricing.png) | [png](screenshots/mobile/pub-pricing.png) |
| `acct-profile` | `/app/account` | [png](screenshots/desktop/acct-profile.png) | [png](screenshots/mobile/acct-profile.png) |
| `acct-usage` | `/app/account/usage` | [png](screenshots/desktop/acct-usage.png) | [png](screenshots/mobile/acct-usage.png) |
| `acct-keys` | `/app/account/keys` | [png](screenshots/desktop/acct-keys.png) | [png](screenshots/mobile/acct-keys.png) |
| `acct-key-new` | `/app/account/keys/new` | [png](screenshots/desktop/acct-key-new.png) | [png](screenshots/mobile/acct-key-new.png) |
| `acct-identities` | `/app/account/identities` | [png](screenshots/desktop/acct-identities.png) | [png](screenshots/mobile/acct-identities.png) |
| `acct-notifications` | `/app/account/notifications` | [png](screenshots/desktop/acct-notifications.png) | [png](screenshots/mobile/acct-notifications.png) |
| `app-home` | `/app` | [png](screenshots/desktop/app-home.png) | [png](screenshots/mobile/app-home.png) |
| `org-create` | `/app/organizations/new` | [png](screenshots/desktop/org-create.png) | [png](screenshots/mobile/org-create.png) |
| `org-overview` | `/app/:org` | [png](screenshots/desktop/org-overview.png) | [png](screenshots/mobile/org-overview.png) |
| `org-settings` | `/app/:org/settings` | [png](screenshots/desktop/org-settings.png) | [png](screenshots/mobile/org-settings.png) |
| `org-members` | `/app/:org/settings/members` | [png](screenshots/desktop/org-members.png) | [png](screenshots/mobile/org-members.png) |
| `org-audit` | `/app/:org/settings/audit` | [png](screenshots/desktop/org-audit.png) | [png](screenshots/mobile/org-audit.png) |
| `proj-create` | `/app/:org/new-project` | [png](screenshots/desktop/proj-create.png) | [png](screenshots/mobile/proj-create.png) |
| `proj-overview` | `/app/:org/:project` | [png](screenshots/desktop/proj-overview.png) | [png](screenshots/mobile/proj-overview.png) |
| `proj-settings` | `/app/:org/:project/settings` | [png](screenshots/desktop/proj-settings.png) | [png](screenshots/mobile/proj-settings.png) |
| `proj-package` | `/app/:org/:project/package` | [png](screenshots/desktop/proj-package.png) | [png](screenshots/mobile/proj-package.png) |
| `case-list` | `/app/:org/:project/cases` | [png](screenshots/desktop/case-list.png) | [png](screenshots/mobile/case-list.png) |
| `case-detail` | `/app/:org/:project/cases/:case` | [png](screenshots/desktop/case-detail.png) | [png](screenshots/mobile/case-detail.png) |
| `case-composer` | `/app/:org/:project/cases/:case/compose` | [png](screenshots/desktop/case-composer.png) | [png](screenshots/mobile/case-composer.png) |
| `case-revision` | `/app/:org/:project/cases/:case/revisions/:revision` | [png](screenshots/desktop/case-revision.png) | [png](screenshots/mobile/case-revision.png) |
| `case-compare` | `/app/:org/:project/cases/:case/compare` | [png](screenshots/desktop/case-compare.png) | [png](screenshots/mobile/case-compare.png) |
| `wb-workbench` | `/app/:org/:project/workbench` | [png](screenshots/desktop/wb-workbench.png) | [png](screenshots/mobile/wb-workbench.png) |
| `snap-detail` | `/app/:org/:project/snapshots/:snapshot` | [png](screenshots/desktop/snap-detail.png) | [png](screenshots/mobile/snap-detail.png) |
| `lib-list` | `/app/:org/library` | [png](screenshots/desktop/lib-list.png) | [png](screenshots/mobile/lib-list.png) |
| `lib-artifact` | `/app/:org/library/:artifact` | [png](screenshots/desktop/lib-artifact.png) | [png](screenshots/mobile/lib-artifact.png) |
| `lib-draft` | `/app/:org/library/:artifact/drafts/:draft` | [png](screenshots/desktop/lib-draft.png) | [png](screenshots/mobile/lib-draft.png) |
| `lib-version` | `/app/:org/library/:artifact/versions/:version` | [png](screenshots/desktop/lib-version.png) | [png](screenshots/mobile/lib-version.png) |
| `proj-library` | `/app/:org/:project/library` | [png](screenshots/desktop/proj-library.png) | [png](screenshots/mobile/proj-library.png) |
| `proj-files` | `/app/:org/:project/files` | [png](screenshots/desktop/proj-files.png) | [png](screenshots/mobile/proj-files.png) |
| `proj-resources` | `/app/:org/:project/resources` | [png](screenshots/desktop/proj-resources.png) | [png](screenshots/mobile/proj-resources.png) |
| `proj-resource-detail` | `/app/:org/:project/resources/:resource` | [png](screenshots/desktop/proj-resource-detail.png) | [png](screenshots/mobile/proj-resource-detail.png) |
| `coll-list` | `/app/:org/:project/collections` | [png](screenshots/desktop/coll-list.png) | [png](screenshots/mobile/coll-list.png) |
| `coll-detail` | `/app/:org/:project/collections/:collection` | [png](screenshots/desktop/coll-detail.png) | [png](screenshots/mobile/coll-detail.png) |
| `gen-lab` | `/app/generator` | [png](screenshots/desktop/gen-lab.png) | [png](screenshots/mobile/gen-lab.png) |
| `job-launch` | `/app/:org/:project/jobs/new` | [png](screenshots/desktop/job-launch.png) | [png](screenshots/mobile/job-launch.png) |
| `job-list` | `/app/:org/:project/jobs` | [png](screenshots/desktop/job-list.png) | [png](screenshots/mobile/job-list.png) |
| `job-detail` | `/app/:org/:project/jobs/:job` | [png](screenshots/desktop/job-detail.png) | [png](screenshots/mobile/job-detail.png) |
| `job-history` | `/app/jobs` | [png](screenshots/desktop/job-history.png) | [png](screenshots/mobile/job-history.png) |
| `study-list` | `/app/:org/:project/studies` | [png](screenshots/desktop/study-list.png) | [png](screenshots/mobile/study-list.png) |
| `study-builder` | `/app/:org/:project/studies/new` | [png](screenshots/desktop/study-builder.png) | [png](screenshots/mobile/study-builder.png) |
| `study-detail` | `/app/:org/:project/studies/:study` | [png](screenshots/desktop/study-detail.png) | [png](screenshots/mobile/study-detail.png) |
| `study-run` | `/app/:org/:project/studies/:study/runs/:run` | [png](screenshots/desktop/study-run.png) | [png](screenshots/mobile/study-run.png) |
| `study-cell` | `/app/:org/:project/studies/:study/runs/:run/cells/:cell` | [png](screenshots/desktop/study-cell.png) | [png](screenshots/mobile/study-cell.png) |
| `study-analytics` | `/app/:org/:project/studies/:study/runs/:run/analytics` | [png](screenshots/desktop/study-analytics.png) | [png](screenshots/mobile/study-analytics.png) |
| `analysis-sources` | `/app/analysis` | [png](screenshots/desktop/analysis-sources.png) | [png](screenshots/mobile/analysis-sources.png) |
| `analysis-workspace` | `/app/analysis/workspace` | [png](screenshots/desktop/analysis-workspace.png) | [png](screenshots/mobile/analysis-workspace.png) |
| `rep-list` | `/app/:org/:project/reports` | [png](screenshots/desktop/rep-list.png) | [png](screenshots/mobile/rep-list.png) |
| `rep-detail` | `/app/:org/:project/reports/:report` | [png](screenshots/desktop/rep-detail.png) | [png](screenshots/mobile/rep-detail.png) |
| `proj-publications` | `/app/:org/:project/publications` | [png](screenshots/desktop/proj-publications.png) | [png](screenshots/mobile/proj-publications.png) |
| `verifier` | `/app/verifier` | [png](screenshots/desktop/verifier.png) | [png](screenshots/mobile/verifier.png) |
| `eng-register` | `/app/engines/new` | [png](screenshots/desktop/eng-register.png) | [png](screenshots/mobile/eng-register.png) |
| `eng-registrations` | `/app/engines/registrations` | [png](screenshots/desktop/eng-registrations.png) | [png](screenshots/mobile/eng-registrations.png) |
| `eng-registration-detail` | `/app/engines/registrations/:name` | [png](screenshots/desktop/eng-registration-detail.png) | [png](screenshots/mobile/eng-registration-detail.png) |
| `lang-extensions` | `/app/language/extensions` | [png](screenshots/desktop/lang-extensions.png) | [png](screenshots/mobile/lang-extensions.png) |
| `admin-overview` | `/app/admin` | [png](screenshots/desktop/admin-overview.png) | [png](screenshots/mobile/admin-overview.png) |
| `admin-users` | `/app/admin/users` | [png](screenshots/desktop/admin-users.png) | [png](screenshots/mobile/admin-users.png) |
| `admin-user-detail` | `/app/admin/users/:user` | [png](screenshots/desktop/admin-user-detail.png) | [png](screenshots/mobile/admin-user-detail.png) |
| `admin-audit` | `/app/admin/audit` | [png](screenshots/desktop/admin-audit.png) | [png](screenshots/mobile/admin-audit.png) |
| `admin-errors` | `/app/admin/errors` | [png](screenshots/desktop/admin-errors.png) | [png](screenshots/mobile/admin-errors.png) |
| `admin-queues` | `/app/admin/queues` | [png](screenshots/desktop/admin-queues.png) | [png](screenshots/mobile/admin-queues.png) |
| `admin-moderation` | `/app/admin/moderation` | [png](screenshots/desktop/admin-moderation.png) | [png](screenshots/mobile/admin-moderation.png) |
| `admin-maintenance` | `/app/admin/maintenance` | [png](screenshots/desktop/admin-maintenance.png) | [png](screenshots/mobile/admin-maintenance.png) |
| `admin-routing` | `/app/admin/engine-routing` | [png](screenshots/desktop/admin-routing.png) | [png](screenshots/mobile/admin-routing.png) |
| `admin-sponsor` | `/app/admin/organizations/:org/sponsor` | [png](screenshots/desktop/admin-sponsor.png) | [png](screenshots/mobile/admin-sponsor.png) |
| `admin-pricing` | `/app/admin/pricing` | [png](screenshots/desktop/admin-pricing.png) | [png](screenshots/mobile/admin-pricing.png) |
| `admin-pricing-draft` | `/app/admin/pricing/drafts/new` | [png](screenshots/desktop/admin-pricing-draft.png) | [png](screenshots/mobile/admin-pricing-draft.png) |
| `admin-pricing-release` | `/app/admin/pricing/:version` | [png](screenshots/desktop/admin-pricing-release.png) | [png](screenshots/mobile/admin-pricing-release.png) |

## Pantallas que se muestran en estado inicial

Todas las pantallas cuyo contenido viene de la API están pobladas. Estas se capturan en su estado inicial por lo que
son, no por falta de mock:

| id | por qué |
| --- | --- |
| `auth-login`, `auth-register`, `auth-reset-request` | Formularios de entrada: sin datos que mostrar. |
| `auth-cas-callback` | Se abre con un código de un solo uso de la universidad; sin él muestra «There’s no code to finish sign-in». Con código dispararía un intercambio de sesión que el mock no simula. |
| `org-invite-accept` | Con la sesión abierta pide pegar el token de la invitación. Con token intentaría aceptarla (escritura). |
| `org-create`, `proj-create`, `acct-key-new`, `eng-register`, `admin-pricing-draft`, `job-launch`, `study-builder` | Asistentes: se captura el primer paso. Las listas que alimentan el paso (casos, motores, versiones, límites) sí están pobladas. |
| `pub-workbench`, `wb-workbench` | Muestran el espacio de trabajo antes de pulsar «Validate»; el resultado de validar es una acción, no una carga. |
| `admin-sponsor` | La pantalla empieza sin cuenta elegida; el resumen de límites aparece tras buscarla y elegirla. |
| `gen-lab` | Herramienta con valores por defecto; el resultado aparece al generar (escritura). |

Limitaciones de la galería: solo se captura la primera pantalla de cada ruta (no hay capturas `__lower`), de modo que lo
que queda debajo del pliegue (por ejemplo, el resultado de un `job-detail` o las tablas largas de administración) se
valida con las mediciones y no en imagen; y no se capturan estados de error, vacíos ni diálogos abiertos (los cubren los
specs `s*.spec.ts`).
