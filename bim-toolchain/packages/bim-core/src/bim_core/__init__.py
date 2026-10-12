"""BIM v1 language implementation.

BIM here is a service-composition and binding language, not Building Information
Modeling.  A package of documents is loaded with :func:`load_package`, validated
against its Profile and Dialects, and lowered by :func:`compile_instance` to the
canonical :class:`BindingProblem` consumed by engines.  Importing this package
reads neither the environment nor any platform setting.
"""

from ._version import __version__
from .assets import schema_root
from .canonical import CanonicalizationError, canonical_json, digest, digest_bytes
from .compiler import (
    BindingProblem,
    CompileDiagnostic,
    compilation_digest,
    compile_instance,
    dialect_descriptor,
    dialect_type_matches,
    dialect_xml_type_matches,
    ir_digest,
    profile_descriptor,
    resource_schema_diagnostics,
    toolchain_identity,
)
from .errors import (
    BimError,
    CompileError,
    ContractError,
    EvaluationError,
    PackageError,
    ProtocolError,
)
from .expressions import ExpressionError
from .package import InstancePackage, load_package
from .settings import Limits, configure, default_limits
from .toolchain import compiler_bundle_digest

__all__ = [
    "BimError",
    "BindingProblem",
    "CanonicalizationError",
    "CompileDiagnostic",
    "CompileError",
    "ContractError",
    "EvaluationError",
    "ExpressionError",
    "InstancePackage",
    "Limits",
    "PackageError",
    "ProtocolError",
    "__version__",
    "canonical_json",
    "compilation_digest",
    "compile_instance",
    "compiler_bundle_digest",
    "configure",
    "default_limits",
    "dialect_descriptor",
    "dialect_type_matches",
    "dialect_xml_type_matches",
    "digest",
    "digest_bytes",
    "ir_digest",
    "load_package",
    "profile_descriptor",
    "resource_schema_diagnostics",
    "schema_root",
    "toolchain_identity",
]
