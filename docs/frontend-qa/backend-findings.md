# Hallazgos para el backend

Dudas y riesgos que salieron de la revisión del frontend y que **no se resuelven en la interfaz**. Antes aparecían como
notas internas («To confirm») dentro de las pantallas; se retiraron de la interfaz final y viven aquí. Las pantallas
muestran el estado real del servidor (por ejemplo, un control deshabilitado) sin explicar la duda.

Cada punto indica el código del frontend afectado y el endpoint. Ningún cambio de este documento se ha hecho en el backend.

1. **Un ADMIN de organización puede conceder el rol OWNER (escalada de privilegios).**
   Frontend: `frontend/src/pages/Organization/OrgMembers.tsx` (selector de rol y cola de cambios; no restringe OWNER),
   `frontend/src/api/platform.ts` (`updateMember`, `updateMembersBatch`).
   Endpoints: `PUT /v1/organizations/{org}/members/{user}`, `POST /v1/organizations/{org}/members/batch`.
   Decidir si conceder OWNER debe exigir ser OWNER; hoy el servidor lo acepta a un ADMIN y la pantalla no lo impide.
   RESUELTO en backend: conceder OWNER, o cambiar/quitar a un OWNER existente, exige ser OWNER efectivo de la organización (o administrador de plataforma que ya tenga acceso ADMIN); un ADMIN recibe `403 owner_role_requires_owner` en `PUT`/`DELETE .../members/{user}`, `POST .../members/batch` (el lote sigue siendo atómico: un solo cambio prohibido rechaza todo, con `index` y `user_id` del primero) e invitaciones con `role: "OWNER"` (misma vía de escalada). La protección `409 last_owner` se mantiene.

2. **Un OWNER/admin puede fijar a cualquier usuario activo como patrocinador de facturación sin su consentimiento.**
   Frontend: `frontend/src/pages/Organization/OrgSettings.tsx` (cambio de patrocinador), `frontend/src/pages/Admin/AdminSponsor.tsx`,
   `frontend/src/api/platform.ts` (`updateOrganization`) y `frontend/src/api/client.ts` (`adminTransferSponsor`).
   Endpoints: `PATCH /v1/organizations/{org}` (`billing_sponsor_user_id`), `POST /v1/admin/organizations/{id}/sponsor`.
   El consumo de todo el subárbol pasa a la cuota del patrocinador elegido; falta una aceptación explícita de esa persona.

3. **`POST /v1/generator/calibrate-engine` no hace una comprobación estricta de autorización.**
   Frontend: `frontend/src/pages/Generator/ToolPanes.tsx` (`CalibratePane`), `frontend/src/api/generator.ts` (`calibrate`).
   La restricción a administradores de plataforma existe solo en la interfaz; el modelo que se reajusta es compartido por todos.
   RESUELTO en backend: el endpoint exige administrador de plataforma en el servidor (`403 platform_admin_required`; sin credencial `401`); las claves API necesitan `admin:accounts:write` (`403 insufficient_api_key_permission`). Antes aceptaba incluso peticiones anónimas. `/v1/generator/instances`, `/corpus` y `/convert-legacy` no tocan estado compartido y quedan abiertas a cualquier llamante (persistir exige cuenta y rol MEMBER en el proyecto).

4. **Adjuntar el resultado de un job a una celda de estudio no comprueba caso, motor ni semilla (integridad de la evidencia).**
   Frontend: `frontend/src/pages/Studies/StudyCell.tsx`, `frontend/src/api/platform.ts` (`attachStudyCellResult`).
   Endpoint: `POST /v1/organizations/{org}/projects/{project}/studies/{study}/runs/{run}/cells/{cell}/result`.
   Un job de cualquier caso/motor/semilla de la persona puede quedar como resultado de la celda.
   RESUELTO en backend: además de pertenecer a quien llama y estar terminado, el job debe ser una ejecución de la celda: paquete BIM de la revisión de caso, motor (namespace/nombre/versión/digest), modo (si la celda lo fija) y semilla coinciden; si no, `409 cell_job_mismatch` con `fields` (`case_revision`, `engine`, `mode`, `seed`) y `details` (valor de la celda y del job). Nuevos `409 job_result_missing` (completado sin resultado) y `409 job_already_attached` (job ya asignado a otra celda); `sealed_evidence` se conserva. No se comparan `parameters` ni `optimization`.

5. **Borrar un fichero solo comprueba el rol aunque una versión sellada dependa de él.**
   Frontend: `frontend/src/pages/Resources/ProjFiles.tsx`, `frontend/src/pages/Resources/resourceErrors.ts`.
   Endpoint: `DELETE /v1/organizations/{org}/projects/{project}/blobs/{digest}` (los ficheros del proyecto son blobs direccionados por contenido; `frontend/src/api/platform.ts`, `deleteArtifact`).
   Debería rechazar (409) cuando una revisión o versión sellada lo referencia.
   RESUELTO en backend: `409 blob_in_use` con `references: [{type, count}]` (`library_version`, `report`, `collection_revision`, `case_revision`, `snapshot`, `project_resource_revision`, `publication`; sin nombres). Se consulta por las columnas de digest indexadas del propio proyecto (`content_digest`, `digest`, `target_digest`, `package_digest`, `InstanceResource.digest`) y por `blob_id`, sin recorrer el proyecto; las referencias de otros proyectos no bloquean.

6. **Un proyecto público solo se abre siendo miembro (gap L4).**
   Frontend: `frontend/src/pages/Project/parts.tsx` (la puerta apunta a la tarjeta de Explore).
   Endpoints: `GET /v1/organizations/{org}/projects/{project}` (404 para quien no es miembro) frente a `GET /v1/explore/projects`.
   Decidir si un proyecto público debe poder abrirse en solo lectura sin ser miembro.

7. **El backend genera `web_url` con el formato de URL antiguo.**
   Frontend: `frontend/src/pages/Resolve/resolveModel.ts` (`locationHref` ignora `web_url` y construye las rutas actuales).
   Backend: `openbinding-gateway` `routes/resolve.py` (~línea 414) y `tools/seed_analysis.py` (~línea 352).
   Endpoint: `GET /v1/resolve/{kind}/{digest}`. Varias rutas de `web_url` apuntan a pantallas que ya no existen.

8. **CORS con comodín por defecto y tokens en `localStorage`.**
   Frontend: `frontend/src/api/client.ts` (`ACCESS_TOKEN_KEY`, `REFRESH_TOKEN_KEY`, `setTokens`).
   Un XSS o un origen permitido por el comodín alcanzaría la sesión. Recomendación: política CSP `default-src 'self'`
   (el frontend solo usa fuentes autoalojadas y ningún script de terceros) y lista cerrada de orígenes CORS en producción.

9. **`POST /v1/verifier/inspect` no filtra por visibilidad.**
   Frontend: `frontend/src/pages/Reports/Verifier.tsx`, `frontend/src/api/platform.ts` (`verifierCheck`, `verifierCheckFile`).
   Endpoints: `POST /v1/verifier/inspect`, `POST /v1/verifier/inspect-file`. Devuelve organización, proyecto y título
   de elementos privados a quien conozca la huella.
   RESUELTO en backend: ambos endpoints solo devuelven elementos que el llamante puede ver (miembro de la organización o ancestro, proyecto público —y fichero público—, versión publicada, motor publicado o propio, snapshot compartido, propio o de un caso visible); el resto es indistinguible de una huella no registrada (mismo `status`, campos y `detail`; filtrado en SQL, mismas consultas siempre). Se mantiene la política de autenticación: sin cuenta, `401`. Un administrador de plataforma no obtiene una vista más amplia.

10. **`AdminUserView.cas_verified` es siempre `false`.**
    Frontend: `frontend/src/pages/Admin/AdminUsers.tsx`, `frontend/src/pages/Admin/AdminUserDetail.tsx`, `frontend/src/api/auth.ts`.
    Endpoints: `GET /v1/admin/users`, `GET /v1/admin/users/{id}`. La interfaz no puede mostrar la verificación institucional real.

11. **`PATCH /v1/admin/users` no escribe en el registro de auditoría** (ni al revocar claves ni al resincronizar uso).
    Frontend: `frontend/src/pages/Admin/AdminUsers.tsx`, `frontend/src/pages/Admin/AdminUserDetail.tsx`,
    `frontend/src/pages/Admin/AdminAgreement.tsx` (cada pantalla avisa de que el cambio no queda auditado).
    Endpoints: `PATCH /v1/admin/users/{id}`, `DELETE /v1/admin/users/{id}/api-keys/{key}`, `POST /v1/admin/users/{id}/usage/resync`.

12. **El traspaso de patrocinio se audita con `organization_id` y `/admin/audit` lo omite.**
    Frontend: `frontend/src/pages/Admin/AdminAudit.tsx`, `frontend/src/pages/Admin/AdminSponsor.tsx`.
    Endpoints: `POST /v1/admin/organizations/{id}/sponsor`, `GET /v1/admin/audit`. El evento solo aparece en el registro de la organización.

13. **`Retry-After` no está expuesto por CORS.**
    Frontend: `frontend/src/api/client.ts` (`errorFor`, lee `Retry-After` en el 429), `frontend/src/components/ui/ErrorState.tsx` (cuenta atrás).
    Sin `Access-Control-Expose-Headers: Retry-After` el navegador no deja leer la cabecera y la cuenta atrás nunca aparece.

14. **El callback de CAS debería redirigir con `?error=`.**
    Frontend: `frontend/src/pages/Auth/CasCallback.tsx` (solo entiende `?code=`; sin él muestra «There’s no code to finish sign-in»).
    Endpoint: `GET /v1/auth/cas/callback`. Un fallo de la universidad debería volver al frontend con un código de error legible.

15. **El backend sube el plan a RESEARCH al enlazar la identidad CAS.**
    Frontend: `frontend/src/pages/Account/AccountIdentities.tsx` (frase `DOWNGRADE RESEARCH` al desenlazar), `frontend/src/pages/Auth/CasCallback.tsx`.
    Endpoints: `GET /v1/auth/cas/callback`, `POST /v1/auth/cas/link-intent`, `DELETE /v1/users/me/identities/{id}`.
    El cambio de plan es un efecto lateral del enlace; la persona solo se entera al desenlazar.

## Encontrados durante esta ronda (pendientes de confirmar por el backend)

16. **Algunos 422 llegan con cuerpos de forma distinta** (`{title, detail, diagnostics}` frente a `{detail: [{loc, msg}]}` de FastAPI).
    Frontend: `frontend/src/api/client.ts` (`errorFor` los normaliza a `HttpError.code` / `.diagnostics`).
    Convendría un único esquema de problema en todos los endpoints.

17. **`/v1/admin/pricing/validate` responde 422 para un documento inválido en vez de 200 con `valid: false`.**
    Frontend: `frontend/src/api/platform.ts` (`validatePricing` lee el cuerpo del 422 de forma explícita), `frontend/src/pages/Admin/pricingModel.ts` (`readValidation`).
    Endpoint: `POST /v1/admin/pricing/validate`. Hoy se admiten ambas formas.
