"""Self-Adaptive MAPE-K Engine Routing Module for OpenBinding."""

from .adaptation_manager import AdaptationManager, RoutingPlanResult, get_adaptation_manager
from .capacity_model import CapacityModel, get_capacity_model
from .confidence import ConfidenceEstimator, get_confidence_estimator
from .discrepancy_analyzer import DiscrepancyAnalyzer, get_discrepancy_analyzer
from .features import WorkloadFeatures, extract_features
from .health_monitor import EngineHealthMonitor, EngineHealthSnapshot, get_health_monitor
from .meta_qaco import MetaQacoSolver, get_meta_qaco_solver
from .profiler import EngineProfile, EngineProfiler, get_engine_profiler

__all__ = [
    "AdaptationManager",
    "CapacityModel",
    "ConfidenceEstimator",
    "DiscrepancyAnalyzer",
    "EngineHealthMonitor",
    "EngineHealthSnapshot",
    "EngineProfile",
    "EngineProfiler",
    "MetaQacoSolver",
    "RoutingPlanResult",
    "WorkloadFeatures",
    "extract_features",
    "get_adaptation_manager",
    "get_capacity_model",
    "get_confidence_estimator",
    "get_discrepancy_analyzer",
    "get_engine_profiler",
    "get_health_monitor",
    "get_meta_qaco_solver",
]
