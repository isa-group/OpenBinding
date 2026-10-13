"""Injected limits, the explicit default and the error hierarchy."""

import pytest

import bim_core
from bim_core import (
    BimError,
    CanonicalizationError,
    CompileDiagnostic,
    CompileError,
    ContractError,
    EvaluationError,
    ExpressionError,
    Limits,
    PackageError,
    ProtocolError,
    canonical_json,
    configure,
    default_limits,
    load_package,
)
from bim_core.expressions import compile_expression
from bim_core.package import strict_json_loads

from _minimal import make_zip


@pytest.fixture
def restore_default_limits():
    previous = default_limits()
    yield
    configure(previous)


def test_defaults_are_the_documented_package_limits() -> None:
    limits = Limits()
    assert limits.max_compressed_bytes == 16 * 1024 * 1024
    assert limits.max_expanded_bytes == 64 * 1024 * 1024
    assert limits.max_entry_bytes == 16 * 1024 * 1024
    assert limits.max_entries == 256
    assert limits.max_compression_ratio == 100
    assert limits.max_path_depth == 16
    assert limits.max_integer_bits == 1_000_000


def test_limits_are_immutable() -> None:
    with pytest.raises(AttributeError):
        Limits().max_entries = 1  # type: ignore[misc]


def test_from_env_is_pure_and_reads_only_the_mapping(monkeypatch) -> None:
    monkeypatch.setenv("BIM_MAX_ENTRIES", "3")
    assert Limits.from_env({}) == Limits()
    assert Limits.from_env({"BIM_MAX_ENTRIES": "7", "BIM_MAX_PATH_DEPTH": "4"}) == Limits(
        max_entries=7, max_path_depth=4
    )
    assert Limits.from_env({"BIM_MAX_COMPRESSION_RATIO": "5"}).max_compression_ratio == 5


@pytest.mark.parametrize(
    ("value", "message"),
    [("abc", "BIM_MAX_ENTRIES must be an integer"), ("0", "BIM_MAX_ENTRIES must be positive"),
     ("-4", "BIM_MAX_ENTRIES must be positive")],
)
def test_from_env_rejects_invalid_values_with_the_historical_texts(value: str, message: str) -> None:
    with pytest.raises(ContractError, match=message) as caught:
        Limits.from_env({"BIM_MAX_ENTRIES": value})
    assert caught.value.code == "invalid_limit"


def test_direct_construction_validates_too() -> None:
    with pytest.raises(ContractError):
        Limits(max_entries=0)
    with pytest.raises(ContractError):
        Limits(max_entries=True)  # type: ignore[arg-type]


def test_configure_sets_the_process_default_and_per_call_limits_win(restore_default_limits) -> None:
    archive = make_zip({"instance.json": b"{}", "a.json": b"{}"})
    configure(Limits(max_entries=1))
    assert default_limits() == Limits(max_entries=1)
    with pytest.raises(PackageError, match="more than 1 entries"):
        load_package(archive)
    assert set(load_package(archive, limits=Limits()).files) == {"instance.json", "a.json"}


def test_configure_requires_limits() -> None:
    with pytest.raises(TypeError):
        configure({"max_entries": 1})  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "error_type",
    [PackageError, CompileError, EvaluationError, ProtocolError, ContractError,
     ExpressionError, CanonicalizationError],
)
def test_every_error_is_a_bim_error_and_a_value_error(error_type: type) -> None:
    assert issubclass(error_type, BimError)
    assert issubclass(error_type, ValueError)
    assert issubclass(BimError, Exception)


def test_bim_error_carries_code_message_and_diagnostics() -> None:
    error = BimError("some_code", "something failed", [{"code": "x"}])
    assert (error.code, error.message, str(error)) == ("some_code", "something failed", "something failed")
    assert error.as_dict() == {
        "code": "some_code", "message": "something failed", "diagnostics": [{"code": "x"}],
    }
    assert BimError("c", "m").as_dict() == {"code": "c", "message": "m"}


def test_package_error_keeps_its_message_and_gets_a_code() -> None:
    with pytest.raises(PackageError) as caught:
        load_package(b"not a zip archive")
    assert str(caught.value) == "invalid ZIP archive"
    assert caught.value.code == "package_error"
    with pytest.raises(PackageError, match="non-finite JSON number: NaN"):
        strict_json_loads(b"NaN")


def test_compile_error_joins_diagnostic_messages_and_serializes_them() -> None:
    diagnostics = [
        CompileDiagnostic("a", "first", "r.json", "/x"),
        CompileDiagnostic("b", "second"),
    ]
    error = CompileError(diagnostics)
    assert str(error) == "first; second"
    assert error.code == "compile_error"
    assert error.diagnostics is diagnostics
    assert error.as_dict()["diagnostics"][0] == {
        "code": "a", "message": "first", "resource": "r.json", "pointer": "/x",
    }


def test_expression_error_keeps_span_and_locate() -> None:
    with pytest.raises(ExpressionError) as caught:
        compile_expression("  true && && false  ", expected_type="bool")
    error = caught.value
    assert isinstance(error, BimError)
    assert str(error) == "invalid CEL expression at 10: invalid syntax"
    assert error.code == "expression_error"
    assert error.span == {"start": 10, "end": 12}
    other = ExpressionError("boom")
    other.locate({"start": 1, "end": 2})
    other.locate({"start": 5, "end": 6})
    assert other.span == {"start": 1, "end": 2}


def test_canonicalization_error_is_a_bim_error() -> None:
    with pytest.raises(CanonicalizationError, match="non-finite number at") as caught:
        canonical_json(float("nan"))
    assert caught.value.code == "canonicalization_error"
    assert isinstance(caught.value, BimError)


def test_package_exposes_the_errors_at_top_level() -> None:
    for name in ("BimError", "PackageError", "CompileError", "EvaluationError", "ProtocolError", "ContractError"):
        assert name in bim_core.__all__
