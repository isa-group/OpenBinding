"""``tools/verify_release.py``: reproducible builds are really compared, a difference is explained member by member, a failed
step fails the run, and a missing ``uv`` is an error, not a skip.  The two builds are made for real (one package)."""

from __future__ import annotations

import io
import json
import shutil
import tarfile
import zipfile
from pathlib import Path

import pytest

import packaging_support as ps
import verify_release


def write_wheel(path: Path, members: dict[str, bytes], *, timestamp: tuple[int, ...] = (2026, 1, 1, 0, 0, 0)) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in members.items():
            info = zipfile.ZipInfo(name, date_time=timestamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return path


def write_sdist(path: Path, members: dict[str, bytes], *, mtime: int = 1767225600, mode: int = 0o644) -> Path:
    with tarfile.open(path, "w:gz") as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.mode = len(data), mtime, mode
            archive.addfile(info, io.BytesIO(data))
    return path


def test_identical_archives_are_reported_identical(tmp_path: Path) -> None:
    members = {"a/x.py": b"x = 1\n", "a-1.dist-info/WHEEL": b"Generator: hatchling 1.27.0\n"}
    first = write_wheel(tmp_path / "one.whl", members)
    second = write_wheel(tmp_path / "two.whl", members)
    # the name is the artifact's; the comparison is by name, so build two directories with the same name
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    shutil.copy(first, tmp_path / "a" / "x.whl")
    shutil.copy(second, tmp_path / "b" / "x.whl")
    report = verify_release.compare_builds({"x.whl": tmp_path / "a" / "x.whl"}, {"x.whl": tmp_path / "b" / "x.whl"})
    assert report["x.whl"]["identical"] is True and report["x.whl"]["sha256"] == report["x.whl"]["sha256Second"]
    assert "differences" not in report["x.whl"]


def test_a_wheel_that_differs_says_which_member_and_which_field(tmp_path: Path) -> None:
    first = write_wheel(tmp_path / "one.whl", {"a/x.py": b"x = 1\n", "a/y.py": b"y = 1\n"})
    second = write_wheel(tmp_path / "two.whl", {"a/x.py": b"x = 2\n", "a/y.py": b"y = 1\n"}, timestamp=(2026, 1, 2, 0, 0, 0))
    found = verify_release.differences(first, second)
    assert any(item.startswith("a/x.py: CRC") for item in found)
    assert any(item.startswith("a/x.py: date_time") for item in found)
    assert any(item.startswith("a/y.py: date_time") for item in found)
    assert not any(item.startswith("a/y.py: CRC") for item in found)


def test_an_sdist_that_differs_says_which_member_and_which_field(tmp_path: Path) -> None:
    first = write_sdist(tmp_path / "one.tar.gz", {"p-1/PKG-INFO": b"Name: p\n", "p-1/src/x.py": b"x = 1\n"})
    second = write_sdist(tmp_path / "two.tar.gz", {"p-1/PKG-INFO": b"Name: p\n", "p-1/src/x.py": b"x = 2\n"}, mtime=1, mode=0o755)
    found = verify_release.differences(first, second)
    assert any(item.startswith("p-1/src/x.py: content sha256") for item in found)
    assert any(item.startswith("p-1/src/x.py: mtime") for item in found)
    assert any(item.startswith("p-1/src/x.py: mode") for item in found)
    assert not any(item.startswith("p-1/PKG-INFO: content") for item in found)


def test_members_present_in_one_build_only_are_named(tmp_path: Path) -> None:
    first = write_wheel(tmp_path / "one.whl", {"a/x.py": b"1", "a/only_first.py": b"1"})
    second = write_wheel(tmp_path / "two.whl", {"a/x.py": b"1", "a/only_second.py": b"1"})
    (found,) = [item for item in verify_release.differences(first, second) if item.startswith("members differ")]
    assert "only_first.py" in found and "only_second.py" in found


def test_an_artifact_built_by_one_run_only_is_not_identical(tmp_path: Path) -> None:
    wheel = write_wheel(tmp_path / "x.whl", {"a/x.py": b"1"})
    report = verify_release.compare_builds({"x.whl": wheel}, {})
    assert report["x.whl"]["identical"] is False and "first" in report["x.whl"]["differences"][0]


def test_the_report_is_ok_only_if_something_ran_and_everything_passed() -> None:
    report = verify_release.Report()
    assert report.ok is False
    report.add("one", True)
    assert report.ok is True
    report.add("two", False, detail="boom")
    assert report.ok is False and report.checks["two"] == {"ok": False, "detail": "boom"}


def test_a_missing_uv_is_an_error_and_a_failed_run(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(shutil, "which", lambda *_: None)
    with pytest.raises(ps.BuildError, match="uv is required"):
        ps.require_uv()
    assert verify_release.main([]) == 1
    summary = json.loads(capsys.readouterr().out)
    assert summary["ok"] is False and "uv is required" in summary["checks"]["environment"]["error"]


def test_the_epoch_and_the_environment_of_a_build_are_fixed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PYTHONPATH", "/somewhere")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1")
    environment = ps.build_environment()
    assert environment["SOURCE_DATE_EPOCH"] == ps.SOURCE_DATE_EPOCH == "1767225600"
    assert "PYTHONPATH" not in environment


def test_the_copy_a_build_reads_has_the_packages_without_tests(tmp_path: Path) -> None:
    target = ps.copy_source_tree(ps.ROOT, tmp_path / "copy")
    assert (target / "pyproject.toml").is_file() and (target / "NOTICE.md").is_file()
    for name in ps.PACKAGES:
        assert (target / "packages" / name / "pyproject.toml").is_file()
        assert (target / "packages" / name / "src").is_dir()
        assert not (target / "packages" / name / "tests").exists()


def test_the_wheel_generator_is_read_from_the_wheel_file(tmp_path: Path) -> None:
    wheel = write_wheel(tmp_path / "x.whl", {"x-1.dist-info/WHEEL": b"Wheel-Version: 1.0\nGenerator: hatchling 9.9.9\n"})
    assert ps.wheel_generator(wheel) == "hatchling 9.9.9"


def test_two_builds_in_two_directories_give_the_same_bytes(tmp_path: Path) -> None:
    """A real build, twice, from two copies of the sources in two directories, with the fixed epoch: same SHA-256."""
    builds = {}
    for label in ("first", "second"):
        tree = ps.copy_source_tree(ps.ROOT, tmp_path / label / "source")
        builds[label] = ps.build_distributions(tree, tmp_path / label / "dist", names=("bim-client",))
    assert sorted(builds["first"]) == sorted(builds["second"]) and len(builds["first"]) == 2
    report = verify_release.compare_builds(builds["first"], builds["second"])
    assert {name: item.get("differences") for name, item in report.items() if not item["identical"]} == {}
    assert all(item["identical"] for item in report.values())
