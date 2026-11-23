import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "publish-desktop-updates.py"
SPEC = importlib.util.spec_from_file_location("tpv_publish_desktop_updates", SCRIPT)
publisher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = publisher
SPEC.loader.exec_module(publisher)
OPENSSL = shutil.which("openssl") or next((str(path) for path in (
    Path("C:/Program Files/Git/usr/bin/openssl.exe"),
    Path("C:/Program Files/Git/mingw64/bin/openssl.exe"),
) if path.is_file()), None)


def json_file(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def decode_url(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class UpdateFeedPublisher(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tpv-update-fixture-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.sources = {}
        self.output = self.root / "feeds"
        for product in publisher.PRODUCTS:
            source = self.root / product
            source.mkdir()
            (self.output / product).mkdir(parents=True)
            self.sources[product] = publisher.ReleaseSource(source, None)

    def release(self, product, version, packages):
        folder = self.sources[product].root / ("v" + version)
        folder.mkdir()
        manifest_key, name_key = ("artifacts", "file") if product == "booth" else ("assets", "name")
        assets = []
        for name, data in packages.items():
            (folder / name).write_bytes(data)
            assets.append({name_key: name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        json_file(folder / "release-manifest.json", {"version": version, manifest_key: assets})
        return folder

    def plan(self, product):
        return publisher.plan_product(product, self.sources[product])

    def test_numeric_versions_and_partial_studio_releases_stay_separate(self):
        studio_old_win = "tpv-karaoke-studio-0.8.0-windows-x64.zip"
        studio_old_mac = "tpv-karaoke-studio-0.8.0-macos-arm64.dmg"
        studio_new_win = "tpv-karaoke-studio-0.11.2-windows-x64-setup.exe"
        studio_not_target = "tpv-karaoke-studio-0.11.2-win-arm64.zip"
        self.release("studio", "0.8.0", {studio_old_win: b"old-win", studio_old_mac: b"old-mac"})
        self.release("studio", "0.11.2", {studio_new_win: b"new-win", studio_not_target: b"unrecognized"})
        feeds = self.plan("studio")
        self.assertEqual(set(feeds), {("win32", "x64"), ("darwin", "arm64")})
        self.assertEqual(feeds["win32", "x64"].payload["version"], "0.11.2")
        self.assertEqual(feeds["darwin", "arm64"].payload["version"], "0.8.0")
        self.assertEqual(feeds["win32", "x64"].payload["artifacts"][0], {
            "platform": "win32", "arch": "x64", "kind": "nsis", "file": studio_new_win,
            "bytes": 7, "sha256": hashlib.sha256(b"new-win").hexdigest(),
        })
        self.assertEqual(feeds["darwin", "arm64"].payload["artifacts"][0]["file"], studio_old_mac)

    def test_hashes_sizes_duplicate_names_and_exact_filenames(self):
        old_name = "Proper-Karaoke-Booth-0.10.9-windows-x64-setup.exe"
        corrupted = "Proper-Karaoke-Booth-0.10.13-windows-x64-setup.exe"
        wrong_size = "Proper-Karaoke-Booth-0.10.13-win-x64.zip"
        valid_name = "Proper-Karaoke-Booth-0.10.13-mac-x64.pkg"
        unrelated = "Proper-Karaoke-Booth-0.10.13-mac-x64-foreign.pkg"
        self.release("booth", "0.10.9", {old_name: b"first"})
        latest = self.release("booth", "0.10.13", {corrupted: b"truth", wrong_size: b"valid-size", valid_name: b"installer", unrelated: b"anything"})
        (latest / corrupted).write_bytes(b"FALSE")  # Same size, different hash.
        (latest / wrong_size).write_bytes(b"excess bytes")
        feeds = self.plan("booth")
        self.assertEqual(set(feeds), {("win32", "x64"), ("darwin", "x64")})
        self.assertEqual(feeds["win32", "x64"].payload["version"], "0.10.9")
        self.assertEqual(feeds["darwin", "x64"].payload["artifacts"][0]["file"], valid_name)
        manifest_path = latest / "release-manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["artifacts"].append(manifest["artifacts"][2])
        json_file(manifest_path, manifest)
        self.assertEqual(set(self.plan("booth")), {("win32", "x64")})

    def test_missing_and_linked_artifacts_are_not_signed(self):
        name = "tpv-karaoke-studio-1.0.0-macos-arm64.dmg"
        release = self.release("studio", "1.0.0", {name: b"original"})
        (release / name).unlink()
        self.assertEqual(self.plan("studio"), {})
        other = self.root / "foreign"
        other.write_bytes(b"original")
        try:
            (release / name).symlink_to(other)
        except OSError:
            self.skipTest("Symlink creation needs OS support.")
        self.assertEqual(self.plan("studio"), {})

    @unittest.skipUnless(OPENSSL, "OpenSSL 3+ is required for real Ed25519 verification.")
    def test_exact_wire_bytes_ed25519_and_atomic_publishing(self):
        name = "Proper-Karaoke-Booth-0.10.13-linux-amd64.deb"
        folder = self.release("booth", "0.10.13", {name: b"confirmed"})
        key = self.root / "test-key.pem"
        public = self.root / "test-public.pem"
        subprocess.run([OPENSSL, "genpkey", "-algorithm", "ED25519", "-out", str(key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run([OPENSSL, "pkey", "-in", str(key), "-pubout", "-out", str(public)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        feeds = {"booth": self.plan("booth")}
        self.assertEqual(publisher.publish(feeds, self.output, key, None, OPENSSL), 1)
        target = self.output / "booth/linux-x64.json"
        envelope = json.loads(target.read_bytes())
        self.assertEqual(set(envelope), {"payload", "signature"})
        self.assertTrue(all("=" not in part for part in envelope.values()))
        payload, signature = decode_url(envelope["payload"]), decode_url(envelope["signature"])
        self.assertEqual(payload, publisher.compact_json(feeds["booth"]["linux", "x64"].payload))
        self.assertEqual(len(signature), 64)
        message, signature_file = self.root / "message", self.root / "signature"
        message.write_bytes(payload)
        signature_file.write_bytes(signature)
        verify = [OPENSSL, "pkeyutl", "-verify", "-pubin", "-inkey", str(public), "-rawin", "-in", str(message), "-sigfile", str(signature_file)]
        self.assertEqual(subprocess.run(verify, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode, 0)
        message.write_bytes(payload + b" ")
        self.assertNotEqual(subprocess.run(verify, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode, 0)
        self.assertEqual(publisher.publish(feeds, self.output, key, None, OPENSSL), 0)
        original = target.read_bytes()
        (folder / name).write_bytes(b"replacement")
        with self.assertRaises(ValueError):
            publisher.publish(feeds, self.output, key, None, OPENSSL)
        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(publisher.publish({"booth": self.plan("booth")}, self.output, key, None, OPENSSL), 1)
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
