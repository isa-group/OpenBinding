"""The ZIP container of a BIM package, as bytes, and nothing else.

The platform keeps, serves and builds ``.bim.zip`` archives. What a package *means* (which
entries are legal, how they are normalised, its digests) is decided by the toolchain
(``integrations.bim``): the archives built here are plain, deterministic ZIPs, and the toolchain
canonicalises them when it compiles. Nothing here validates a package; the only thing read before
the toolchain has seen the archive is ``instance.json``, with the toolchain's own size limit.
"""

from __future__ import annotations

import io
import unicodedata
import zipfile
import zlib
from pathlib import Path
from typing import Any, Mapping

from ..core.jsonio import strict_json_loads
from . import bim

#: Files of a package directory that are documentation, not part of the package.
_DIRECTORY_SKIPPED = frozenset({"benchmark-metadata.json", "qfbs-oracle.json", "README.md"})


def zip_files(files: Mapping[str, bytes]) -> bytes:
    """A deterministic STORE archive of ``files`` (sorted by path, fixed timestamps)."""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in sorted(files, key=lambda value: value.encode("utf-8")):
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[path])
    return output.getvalue()


def directory_files(root: Path) -> dict[str, bytes]:
    """The files of a package directory: regular files, without hidden ones or the authoring notes."""
    files: dict[str, bytes] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        if path.name.startswith(".") or path.name in _DIRECTORY_SKIPPED:
            continue
        files[path.relative_to(root).as_posix()] = path.read_bytes()
    return files


def zip_directory(root: Path) -> bytes:
    return zip_files(directory_files(root))


def read_files(archive: bytes) -> dict[str, bytes]:
    """Every file of an archive the toolchain has already accepted (names in NFC, as it normalises them)."""
    files: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as handle:
        for info in handle.infolist():
            if info.is_dir() or info.filename.endswith("/"):
                continue
            files[unicodedata.normalize("NFC", info.filename)] = handle.read(info)
    return files


def instance_document(archive: bytes) -> dict[str, Any] | None:
    """``instance.json`` of an archive, or ``None`` if it cannot be read as a bounded JSON object.

    This runs before the toolchain has judged the archive (the platform needs the Instance to find
    the registry resources it pins), so it trusts nothing in it: it reads one STORED or DEFLATED
    entry, no larger than the toolchain's own entry limit and within its compression ratio, in
    chunks that stop at the declared size, and gives up quietly: the compilation that follows
    reports the real error.
    """
    limits = bim.package_limits()
    limit = limits.get("max_entry_bytes", 16 * 1024 * 1024)
    max_ratio = limits.get("max_compression_ratio", 100)
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as handle:
            info = next((item for item in handle.infolist() if item.filename == "instance.json"), None)
            if info is None or not _readable(info, limit, max_ratio):
                return None
            with handle.open(info) as entry:
                content = _read_bounded(entry, info.file_size)
            if content is None:
                return None
            document = strict_json_loads(content)
    except (zipfile.BadZipFile, ValueError, OSError, RuntimeError, EOFError, zlib.error, NotImplementedError):
        return None
    return document if isinstance(document, dict) else None


#: The compression methods the toolchain reads; BZIP2 and LZMA inflate a whole stream per call.
_ALLOWED_COMPRESSION = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})
_READ_CHUNK = 64 * 1024


def _readable(info: zipfile.ZipInfo, limit: int, max_ratio: int) -> bool:
    """Whether the header of ``info`` describes an entry worth reading (the toolchain's own rules)."""
    if info.flag_bits & 0x1 or info.compress_type not in _ALLOWED_COMPRESSION:
        return False
    if info.file_size > limit or (info.file_size and not info.compress_size):
        return False
    return not (info.compress_size and info.file_size / info.compress_size > max_ratio)


def _read_bounded(entry: Any, limit: int) -> bytes | None:
    """The bytes of ``entry``, or ``None`` as soon as it yields more than ``limit`` (a lying header)."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = entry.read(min(_READ_CHUNK, limit - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            return None
        chunks.append(chunk)
    content = b"".join(chunks)
    return content if len(content) == limit else None
