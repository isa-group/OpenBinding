"""BIM Generator: Synthesis, Legacy Parser, and Compatibility Engine for BIM v1 QACO Instances."""

from .compatibility import (
    IncompatibleTargetEnginesError,
    TargetCapabilities,
    resolve_engine_capabilities,
)
from .legacy_parser import (
    CandidateService,
    LegacyConstraint,
    LegacyProblem,
    QoSPropertySpec,
    StructureNode,
    parse_legacy_file,
    parse_legacy_structure,
)
from .postprocessor import BIMPostprocessor, normalize_probabilities
from .synthesizer import (
    ProblemSynthesizer,
    generate_instance_package,
    run_legacy_cli,
)

__all__ = [
    "IncompatibleTargetEnginesError",
    "TargetCapabilities",
    "resolve_engine_capabilities",
    "CandidateService",
    "LegacyConstraint",
    "LegacyProblem",
    "QoSPropertySpec",
    "StructureNode",
    "parse_legacy_file",
    "parse_legacy_structure",
    "BIMPostprocessor",
    "normalize_probabilities",
    "ProblemSynthesizer",
    "generate_instance_package",
    "run_legacy_cli",
]
