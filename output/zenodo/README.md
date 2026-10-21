# QACOBench — artefactos para Zenodo

Los dos depósitos están preparados como borradores, sin publicar. Los archivos de
la versión 1.1.1 se suben a esos mismos borradores (Zenodo permite reemplazar
ficheros mientras el registro no está publicado), de modo que los DOI reservados
se conservan.

| Depósito | Borrador | DOI reservado | Archivo |
|---|---|---|---|
| Software | https://zenodo.org/uploads/23336988 | 10.5281/zenodo.23336988 | `qacobench-software-1.1.1.tar.xz` |
| Dataset BIM | https://zenodo.org/uploads/23337038 | 10.5281/zenodo.23337038 | `qacobench-bim-dataset-1.1.1.tar.xz` |

Los DOI reservados se activarán al publicar los registros.

## Construcción de los archivos

Desde la raíz del repositorio, con las siete carpetas de instancias ya
regeneradas (`run.sh transform` y `run.sh generate`) y la campaña ejecutada:

```sh
tools/package_zenodo.sh 1.1.1
```

El script escribe los dos `.tar.xz` en este directorio y sus sumas SHA-256:

* el software contiene el repositorio completo (código, esquemas, motores,
  configuración Docker, entradas originales en `datasets/sources/`, scripts de
  transformación, documentación, cuadernos) y los resultados registrados de la
  campaña en `.artifacts/qacobench/`, **sin** las siete carpetas de instancias
  `datasets/0*_*/`;
* el dataset contiene únicamente esas siete carpetas, más `datasets/README.md`,
  `datasets/ATTRIBUTION.md` y `datasets/licenses/`.

Se conservan las plantillas `.env.example`. Los paquetes excluyen los `.env`
reales, `.git`, `.venv`, `node_modules`, cachés y restos del sistema como
`__MACOSX`, `.DS_Store`, `._*`, `Thumbs.db` y `desktop.ini`.

Para usar ambos juntos, extrae los dos archivos en el mismo directorio; el
dataset quedará bajo `datasets/`.
