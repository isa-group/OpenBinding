"""Secure, non-extracting reader for deterministic ``.bim.zip`` packages."""

from __future__ import annotations

import io
import json
import os
import posixpath
import stat
import re
import unicodedata
import zipfile
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from lxml import etree

from .assets import BPMN_SCHEMA_ENTRY, bpmn_schema_directory
from .canonical import CanonicalizationError, canonical_json, digest_bytes
from .errors import PackageError
from .settings import Limits, default_limits

__all__ = [
    "InstancePackage",
    "PackageError",
    "load_package",
    "resource_digest",
    "strict_json_loads",
]


@lru_cache(maxsize=1)
def _bpmn_schema() -> etree.XMLSchema:
    """Compile the vendored normative OMG BPMN 2.0.2 schema without network I/O."""
    parser = etree.XMLParser(
        resolve_entities=False,
        load_dtd=False,
        no_network=True,
        recover=False,
        huge_tree=False,
    )
    try:
        with bpmn_schema_directory() as directory:
            schema_document = etree.parse(str(directory / BPMN_SCHEMA_ENTRY), parser)
            return etree.XMLSchema(schema_document)
    except (OSError, etree.XMLSchemaParseError, etree.XMLSyntaxError) as exc:
        raise RuntimeError("vendored OMG BPMN 2.0.2 XML Schema bundle is unavailable or invalid") from exc


def strict_json_loads(data: str | bytes) -> Any:
    """Parse I-JSON without silently accepting duplicate object names."""

    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise PackageError(f"duplicate JSON object member: {key!r}")
            result[key] = value
        return result

    def invalid_constant(value: str) -> None:
        raise PackageError(f"non-finite JSON number: {value}")

    try:
        return json.loads(data, object_pairs_hook=object_pairs, parse_constant=invalid_constant)
    except UnicodeDecodeError as exc:
        raise PackageError("JSON is not valid UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise PackageError(f"invalid JSON: {exc.msg}") from exc


def _canonical_resource_bytes(path: str, content: bytes) -> bytes:
    """Return the bytes covered by resource and portable-package digests."""
    if path.lower().endswith(".json"):
        try:
            return canonical_json(strict_json_loads(content))
        except (PackageError, CanonicalizationError) as exc:
            raise PackageError(f"resource is not valid UTF-8 JSON: {path}") from exc
    if path.lower().endswith((".xml", ".bpmn")):
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PackageError(f"XML export requires UTF-8: {path}") from exc
        return text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    return content


def resource_digest(path: str, content: bytes) -> str:
    """Digest one BIM resource using the same normalization as a portable ZIP."""
    return digest_bytes(_canonical_resource_bytes(path, content))


def _normal_name(name: str, limits: Limits) -> str:
    if not name or "\x00" in name:
        raise PackageError("package path is empty or contains NUL")
    if "\\" in name or name.startswith("/") or name.startswith("~") or re.match(r"^[A-Za-z]:[/\\]", name):
        raise PackageError(f"unsafe package path: {name!r}")
    if len(name) > 4096:
        raise PackageError(f"package path is too long: {name!r}")
    normalized = unicodedata.normalize("NFC", name)
    if normalized != name:
        name = normalized
    if posixpath.isabs(name):
        raise PackageError(f"absolute package path: {name!r}")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise PackageError(f"traversal or empty component in package path: {name!r}")
    if len(parts) > limits.max_path_depth:
        raise PackageError(f"package path exceeds depth {limits.max_path_depth}: {name!r}")
    return name


def _validate_zip(data: bytes, limits: Limits) -> dict[str, bytes]:
    if len(data) > limits.max_compressed_bytes:
        raise PackageError(f"compressed package exceeds {limits.max_compressed_bytes} bytes")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise PackageError("invalid ZIP archive") from exc

    infos = archive.infolist()
    if len(infos) > limits.max_entries:
        raise PackageError(f"package contains more than {limits.max_entries} entries")
    result: dict[str, bytes] = {}
    folded: set[str] = set()
    expanded = 0
    for info in infos:
        if info.is_dir() or info.filename.endswith("/"):
            _normal_name(info.filename.rstrip("/"), limits)
            continue
        name = _normal_name(info.filename, limits)
        if name in result or name.casefold() in folded:
            raise PackageError(f"duplicate package path: {name!r}")
        folded.add(name.casefold())
        mode = (info.external_attr >> 16) & 0o170000
        if mode == stat.S_IFLNK or info.flag_bits & 0x1:
            raise PackageError(f"symlink or encrypted package entry: {name!r}")
        if info.file_size > limits.max_entry_bytes:
            raise PackageError(f"package entry exceeds {limits.max_entry_bytes} bytes: {name!r}")
        expanded += info.file_size
        if expanded > limits.max_expanded_bytes:
            raise PackageError(f"expanded package exceeds {limits.max_expanded_bytes} bytes")
        if info.file_size and not info.compress_size:
            raise PackageError(f"invalid zero-sized compressed entry: {name!r}")
        if info.compress_size and info.file_size / info.compress_size > limits.max_compression_ratio:
            raise PackageError(f"compression ratio exceeds {limits.max_compression_ratio}: {name!r}")
        try:
            content = archive.read(info)
        except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
            raise PackageError(f"could not read package entry {name!r}") from exc
        if len(content) != info.file_size:
            raise PackageError(f"truncated package entry: {name!r}")
        result[name] = content
    return _validate_files(result, limits)


def _validate_files(files: dict[str, bytes], limits: Limits) -> dict[str, bytes]:
    """Validate every virtual-filesystem construction path uniformly."""
    if len(files) > limits.max_entries:
        raise PackageError(f"package contains more than {limits.max_entries} entries")
    result: dict[str, bytes] = {}
    folded: set[str] = set()
    total = 0
    for supplied_name, content in files.items():
        if not isinstance(supplied_name, str):
            raise PackageError("package file paths must be strings")
        if not isinstance(content, bytes):
            raise PackageError(f"package entry must be bytes: {supplied_name!r}")
        name = _normal_name(supplied_name, limits)
        folded_name = name.casefold()
        if name in result or folded_name in folded:
            raise PackageError(f"duplicate package path: {name!r}")
        folded.add(folded_name)
        if len(content) > limits.max_entry_bytes:
            raise PackageError(f"package entry exceeds {limits.max_entry_bytes} bytes: {name!r}")
        total += len(content)
        if total > limits.max_expanded_bytes:
            raise PackageError(f"expanded package exceeds {limits.max_expanded_bytes} bytes")
        result[name] = content
    if "instance.json" not in result:
        raise PackageError("package must contain instance.json")
    return result


def _read_directory(root: Path, limits: Limits) -> dict[str, bytes]:
    if root.is_symlink() or not root.is_dir():
        raise PackageError(f"package directory does not exist: {root}")
    result: dict[str, bytes] = {}
    total = 0
    for path in root.rglob("*"):
        if path.is_symlink() or not path.is_file():
            if path.is_symlink():
                raise PackageError(f"symlink in package directory: {path}")
            continue
        if path.name.startswith(".") or path.name in {
            "benchmark-metadata.json",
            "qfbs-oracle.json",
            "README.md",
        }:
            continue
        rel = _normal_name(path.relative_to(root).as_posix(), limits)
        if rel in result or rel.casefold() in {key.casefold() for key in result}:
            raise PackageError(f"duplicate package path: {rel!r}")
        size = path.stat().st_size
        if size > limits.max_entry_bytes:
            raise PackageError(f"package entry exceeds {limits.max_entry_bytes} bytes: {rel!r}")
        total += size
        if total > limits.max_expanded_bytes:
            raise PackageError(f"package exceeds {limits.max_expanded_bytes} bytes")
        result[rel] = path.read_bytes()
        if len(result) > limits.max_entries:
            raise PackageError(f"package contains more than {limits.max_entries} entries")
    return _validate_files(result, limits)


@dataclass(frozen=True)
class InstancePackage:
    """An immutable virtual filesystem and its per-file digests.

    ``limits`` are the resource limits it was validated with; when omitted the
    process default (:func:`bim_core.settings.default_limits`) applies.
    """

    files: dict[str, bytes]
    limits: Limits | None = field(default=None, compare=False, repr=False)

    def __post_init__(self) -> None:
        effective = self.limits if self.limits is not None else default_limits()
        object.__setattr__(self, "limits", effective)
        object.__setattr__(self, "files", _validate_files(dict(self.files), effective))

    def bytes(self, path: str) -> bytes:
        try:
            return self.files[path]
        except KeyError as exc:
            raise PackageError(f"resource is not present: {path}") from exc

    def json(self, path: str) -> dict[str, Any]:
        try:
            value = strict_json_loads(self.bytes(path))
        except PackageError as exc:
            raise PackageError(f"resource is not valid UTF-8 JSON: {path}") from exc
        if not isinstance(value, dict):
            raise PackageError(f"resource must be a JSON object: {path}")
        return value

    def xml_root(self, path: str) -> Any:
        """Parse XML securely without assigning it to a dialect or fetching schemas."""
        data = self.bytes(path)
        try:
            data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PackageError(f"XML must be UTF-8: {path}") from exc
        lowered = data.lower()
        if any(marker in lowered for marker in (
            b"<!doctype",
            b"<!entity",
            b"http://www.w3.org/2001/xinclude",
            b"<xi:include",
            b"schemalocation",
            b"document(",
        )):
            raise PackageError(f"XML uses a forbidden external construct: {path}")
        parser = etree.XMLParser(
            resolve_entities=False,
            load_dtd=False,
            no_network=True,
            recover=False,
            huge_tree=False,
        )
        try:
            root = etree.fromstring(data, parser)
        except etree.XMLSyntaxError as exc:
            line, column = exc.position
            raise PackageError(
                f"invalid XML at line {line}, column {column}: {exc.msg}: {path}"
            ) from exc
        return root

    def xml(self, path: str) -> Any:
        """Validate a resource assigned to the installed OMG BPMN 2.0.2 dialect."""
        root = self.xml_root(path)
        try:
            _bpmn_schema().assertValid(root)
        except etree.DocumentInvalid as exc:
            error = exc.error_log.last_error
            if error is None:
                raise PackageError(f"BPMN XML does not conform to OMG BPMN 2.0.2: {path}") from exc
            raise PackageError(
                f"BPMN XML does not conform to OMG BPMN 2.0.2 at line {error.line}, "
                f"column {error.column}: {error.message}: {path}"
            ) from exc
        return root

    def digest(self, path: str) -> str:
        # Resource identity is representation-independent for the formats
        # normalised by the portable package contract.  In particular, a
        # pretty-printed Git directory and its JCS/LF-normalised ZIP must have
        # the same resource, Instance and IR digests.
        return digest_bytes(_canonical_resource_bytes(path, self.bytes(path)))

    @property
    def resource_digests(self) -> dict[str, str]:
        return {path: self.digest(path) for path in sorted(self.files)}

    @property
    def package_digest(self) -> str:
        """Digest of the canonical portable archive, independent of upload form."""
        return digest_bytes(self.to_zip())

    def instance(self) -> dict[str, Any]:
        """Return the strict root index without enriching referenced resources."""
        return self.json("instance.json")

    def to_zip(self) -> bytes:
        """Build a deterministic STORE archive from the virtual filesystem."""
        canonical_files = {
            path: _canonical_resource_bytes(path, content)
            for path, content in self.files.items()
        }
        files = _validate_files(canonical_files, self.limits or default_limits())

        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
            for path in sorted(files, key=lambda value: value.encode("utf-8")):
                info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, files[path])
        return output.getvalue()


def load_package(
    source: str | os.PathLike[str] | bytes | bytearray,
    *,
    limits: Limits | None = None,
) -> InstancePackage:
    """Read a package directory, a ``.bim.zip`` file or ZIP bytes.

    ``limits`` defaults to the process default (see :func:`bim_core.configure`).
    """
    effective = limits if limits is not None else default_limits()
    if isinstance(source, (bytes, bytearray)):
        return InstancePackage(_validate_zip(bytes(source), effective), effective)
    path = Path(source)
    if path.is_dir():
        return InstancePackage(_read_directory(path, effective), effective)
    if path.is_file():
        if path.suffix.lower() == ".json":
            raise PackageError(
                "standalone JSON instances are not part of BIM v1; use the instance directory or .bim.zip"
            )
        return InstancePackage(_validate_zip(path.read_bytes(), effective), effective)
    raise PackageError(f"package source does not exist: {path}")
