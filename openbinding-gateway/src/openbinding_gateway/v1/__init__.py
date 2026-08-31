"""BIM v1 language implementation for the OpenBinding platform.

The v1 package is deliberately independent from the historical instance
model.  Documents are loaded as a package, validated against their kind, and
lowered to the one canonical :class:`BindingProblem` consumed by engines.
"""

from .compiler import BindingProblem, CompileDiagnostic, compile_instance
from .package import InstancePackage, PackageError, load_package

__all__ = [
    "BindingProblem",
    "CompileDiagnostic",
    "InstancePackage",
    "PackageError",
    "compile_instance",
    "load_package",
]
