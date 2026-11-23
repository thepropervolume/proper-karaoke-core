#!/usr/bin/env python3
"""Sign architecture-specific feeds from verified, already-published releases."""

import argparse
import base64
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


OUTPUT = Path("/srv/tpv-desktop-updates")
KEY = Path("/etc/tpv-desktop-updates/signing-ed25519.pem")
LOCK = Path("/run/tpv-desktop-updates/publisher.lock")
PRODUCTS = ("booth", "studio")
PLATFORMS = ("win32", "linux", "darwin")
ARCHES = ("x64", "arm64")
TARGETS = tuple((platform, arch) for platform in PLATFORMS for arch in ARCHES)
VERSION = re.compile(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}")
SHA256 = re.compile(r"[a-f0-9]{64}")
MAX_MANIFEST = 256 * 1024
MAX_ARTIFACT = 2 * 1024**3


@dataclass(frozen=True)
class ReleaseSource:
    root: Path
    owner: int | None


@dataclass(frozen=True)
class VerifiedFile:
    path: Path
    identity: tuple

    def check(self):
        if file_identity(self.path.lstat()) != self.identity:
            raise ValueError("A release file changed during feed generation.")


@dataclass(frozen=True)
class Feed:
    payload: dict
    files: tuple[VerifiedFile, ...]


def artifact_names(product, version):
    names = {}
    mac = "mac" if product == "booth" else "macos"
    prefix = "Proper-Karaoke-Booth" if product == "booth" else "tpv-karaoke-studio"
    windows_zip = "win-x64.zip" if product == "booth" else "windows-x64.zip"
    linux_appimage = "linux-x86_64.AppImage" if product == "booth" else "linux-x64.AppImage"
    linux_deb = "linux-amd64.deb" if product == "booth" else "linux-x64.deb"
    names.update({
        "windows-x64-setup.exe": ("win32", "x64", "nsis"),
        windows_zip: ("win32", "x64", "zip"),
        linux_appimage: ("linux", "x64", "appimage"),
        linux_deb: ("linux", "x64", "deb"),
    })
    for arch in ARCHES:
        for kind in ("dmg", "zip", "pkg") if product == "booth" else ("dmg", "zip"):
            names[f"{mac}-{arch}.{kind}"] = ("darwin", arch, kind)
    return {f"{prefix}-{version}-{name}": values for name, values in names.items()}


def file_identity(info):
    # Windows path metadata adds execute bits based on extension and can use
    # different creation/change time semantics than open handle metadata.
    mode = stat.S_IFMT(info.st_mode) if os.name == "nt" else info.st_mode
    ctime = None if os.name == "nt" else info.st_ctime_ns
    return (info.st_dev, info.st_ino, mode, info.st_uid, info.st_size, info.st_mtime_ns, ctime)


def trusted_path(path, owner, directory=False):
    info = path.lstat()
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if (not expected_type(info.st_mode) or path.resolve(strict=True) != path
            or owner is not None and (info.st_uid != owner or info.st_mode & 0o022)):
        raise ValueError("Unexpected release file type or ownership.")
    return info


@contextmanager
def stable_file(path, owner, size_bound):
    identity = file_identity(trusted_path(path, owner))
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as handle:
        info = os.fstat(handle.fileno())
        if file_identity(info) != identity or not 0 < info.st_size <= size_bound:
            raise ValueError("Unexpected release file size or identity.")
        yield handle, VerifiedFile(path, identity)
        if file_identity(os.fstat(handle.fileno())) != identity or file_identity(path.lstat()) != identity:
            raise ValueError("A release file changed while being read.")


def unique_fields(pairs):
    value = {}
    for name, item in pairs:
        if name in value:
            raise ValueError("Duplicate manifest field.")
        value[name] = item
    return value


def read_manifest(product, release, version, owner):
    trusted_path(release, owner, directory=True)
    with stable_file(release / "release-manifest.json", owner, MAX_MANIFEST) as (handle, manifest_file):
        document = json.loads(handle.read(MAX_MANIFEST + 1), object_pairs_hook=unique_fields)
    array, field = ("artifacts", "file") if product == "booth" else ("assets", "name")
    if not isinstance(document, dict) or document.get("version") != version:
        raise ValueError("Release manifest version does not match its directory.")
    entries = document.get(array)
    if not isinstance(entries, list) or not 0 < len(entries) <= 128:
        raise ValueError("Unexpected release manifest inventory.")
    candidates = {}
    allowed = artifact_names(product, version)
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get(field), str):
            raise ValueError("Unrecognized manifest entry.")
        name = entry[field]
        if name not in allowed:
            continue
        if name in candidates:
            raise ValueError("Duplicate desktop artifact.")
        platform, arch, kind = allowed[name]
        size, digest = entry.get("bytes"), entry.get("sha256")
        if type(size) is not int or not 0 < size <= MAX_ARTIFACT or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ValueError("Invalid desktop artifact checksum or size.")
        candidates[name] = {"platform": platform, "arch": arch, "kind": kind, "file": name, "bytes": size, "sha256": digest}
    return candidates, manifest_file


def verify_artifact(release, artifact, owner):
    with stable_file(release / artifact["file"], owner, MAX_ARTIFACT) as (handle, checked):
        if os.fstat(handle.fileno()).st_size != artifact["bytes"]:
            raise ValueError("Desktop artifact size differs from manifest.")
        if hashlib.file_digest(handle, "sha256").hexdigest() != artifact["sha256"]:
            raise ValueError("Desktop artifact checksum differs from manifest.")
    return checked


def plan_product(product, source):
    trusted_path(source.root, source.owner, directory=True)
    releases = sorted(
        (entry for entry in source.root.iterdir() if entry.name.startswith("v") and VERSION.fullmatch(entry.name[1:])),
        key=lambda entry: tuple(map(int, entry.name[1:].split("."))), reverse=True,
    )
    feeds = {}
    manifest_count = 0
    for release in releases:
        version = release.name[1:]
        try:
            entries, manifest = read_manifest(product, release, version, source.owner)
        except (OSError, ValueError):
            continue
        manifest_count += 1
        candidates = {}
        for artifact in entries.values():
            target = (artifact["platform"], artifact["arch"])
            if target in feeds:
                continue
            try:
                checked = verify_artifact(release, artifact, source.owner)
            except (OSError, ValueError):
                continue
            candidates.setdefault(target, []).append((artifact, checked))
        for target, items in candidates.items():
            items.sort(key=lambda item: item[0]["kind"])
            payload = {"format": 1, "product": product, "version": version, "artifacts": [item[0] for item in items]}
            feeds[target] = Feed(payload, (manifest, *(item[1] for item in items)))
    if not manifest_count:
        raise ValueError(f"No verified manifest is readable for {product}.")
    return feeds


def compact_json(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def base64url(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def sign_feed(feed, key, openssl="/usr/bin/openssl"):
    payload = compact_json(feed.payload)
    # OpenSSL's Ed25519 one-shot operation needs a seekable input.
    with tempfile.TemporaryDirectory(prefix="tpv-feed-sign-") as directory:
        message = Path(directory) / "payload"
        message.write_bytes(payload)
        signature = subprocess.run([openssl, "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(message)],
                                   check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10).stdout
    if len(signature) != 64:
        raise ValueError("Unexpected Ed25519 signature.")
    return compact_json({"payload": base64url(payload), "signature": base64url(signature)}) + b"\n"


def atomic_write(target, contents):
    with tempfile.NamedTemporaryFile(prefix=".tpv-updates-", dir=target.parent, delete=False) as handle:
        pending = Path(handle.name)
        try:
            handle.write(contents)
            handle.flush()
            if hasattr(os, "fchmod"):
                os.fchmod(handle.fileno(), 0o644)
            os.fsync(handle.fileno())
            handle.close()
            os.replace(pending, target)
        finally:
            pending.unlink(missing_ok=True)


def publish(planned, output, key, owner, openssl="/usr/bin/openssl"):
    trusted_path(output, owner, directory=True)
    staged = {}
    # Validate and sign everything before changing any served feed.
    for product, feeds in planned.items():
        destination = output / product
        trusted_path(destination, owner, directory=True)
        for platform, arch in TARGETS:
            path = destination / f"{platform}-{arch}.json"
            previous = None
            if os.path.lexists(path):
                with stable_file(path, owner, MAX_MANIFEST) as (handle, _):
                    previous = handle.read(MAX_MANIFEST + 1)
            feed = feeds.get((platform, arch))
            current = None
            if feed:
                for checked in feed.files:
                    checked.check()
                current = sign_feed(feed, key, openssl)
            if previous != current:
                staged[path] = (feed, current)
    for path, (feed, contents) in staged.items():
        if feed:
            for checked in feed.files:
                checked.check()
            atomic_write(path, contents)
        else:
            path.unlink()
    if staged and hasattr(os, "O_DIRECTORY"):
        for directory in {path.parent for path in staged}:
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    return len(staged)


def validate_key(key):
    trusted_path(key.parent, 0, directory=True)
    info = trusted_path(key, 0)
    if info.st_mode & 0o077 or not 0 < info.st_size <= 4096:
        raise ValueError("The Ed25519 signing key must be private to root.")
    public = subprocess.run(["/usr/bin/openssl", "pkey", "-in", str(key), "-pubout", "-outform", "DER"],
                            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10).stdout
    if len(public) != 44 or not public.startswith(bytes.fromhex("302a300506032b6570032100")):
        raise ValueError("The signing key must be Ed25519.")


def main():
    import fcntl
    import pwd

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Verify released files and print the public payloads without signing.")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PermissionError("Run the publisher as the release server operator.")
    sources = {
        product: ReleaseSource(Path(f"/srv/tpv-{product}-releases/public"), pwd.getpwnam(f"tpv-{product}-release").pw_uid)
        for product in PRODUCTS
    }
    if args.dry_run:
        for product, source in sources.items():
            for feed in plan_product(product, source).values():
                print(compact_json(feed.payload).decode("ascii"))
        return
    validate_key(KEY)
    trusted_path(LOCK.parent, 0, directory=True)
    with os.fdopen(os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "r+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        planned = {product: plan_product(product, source) for product, source in sources.items()}
        print(f"Desktop update feeds changed: {publish(planned, OUTPUT, KEY, 0)}")


if __name__ == "__main__":
    main()
