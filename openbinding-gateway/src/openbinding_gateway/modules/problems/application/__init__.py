"""What the rest of the gateway reads of problems.

Code outside ``modules/problems`` reaches the module through this package only
(``tests/test_modules_cross_import.py``); the composition root mounts the routers of ``adapters``.
"""

from ..domain.compilation import Compilation, analysis_summary, ir_analysis, package_file_digests
from ..domain.digests import is_digest, revision_digest
from .compile import CompileRefusal, compile_package, compile_refusal
from .package import BIM_ZIP_TYPES, PackageRequest, read_package
from .problems import (
    NOT_RECOMPILABLE,
    Upload,
    add_revision,
    compile_or_get,
    create_problem,
    current_compilations,
    delete_problem,
    latest_revisions,
    problem_by_ref,
    revision_by_ref,
    slug_from_name,
    store_compilation,
)
from .templates import TemplatePackage, TemplateProblem, template_package, template_paths
from .validate import validate_package

__all__ = [
    "BIM_ZIP_TYPES",
    "Compilation",
    "CompileRefusal",
    "NOT_RECOMPILABLE",
    "PackageRequest",
    "TemplatePackage",
    "TemplateProblem",
    "Upload",
    "add_revision",
    "analysis_summary",
    "compile_or_get",
    "compile_package",
    "compile_refusal",
    "create_problem",
    "current_compilations",
    "delete_problem",
    "ir_analysis",
    "is_digest",
    "latest_revisions",
    "package_file_digests",
    "problem_by_ref",
    "read_package",
    "revision_by_ref",
    "revision_digest",
    "slug_from_name",
    "store_compilation",
    "template_package",
    "template_paths",
    "validate_package",
]
