from __future__ import annotations

import unittest

from server import ExclusiveThreadingHTTPServer, PLANE_MODEL, PROJECT_ROOT, TrackerRequestHandler


class PublicFileAllowlistTests(unittest.TestCase):
    def test_root_serves_integrated_interface(self) -> None:
        self.assertEqual(TrackerRequestHandler._public_file("/"), PROJECT_ROOT / "index.html")

    def test_public_assets_are_allowed(self) -> None:
        expected = PROJECT_ROOT / "assets" / "js" / "integrated-flight-tracker.js"
        self.assertEqual(
            TrackerRequestHandler._public_file("/assets/js/integrated-flight-tracker.js"),
            expected.resolve(),
        )
        self.assertEqual(TrackerRequestHandler._public_file("/assets/plane.glb"), PLANE_MODEL)

    def test_credentials_and_project_internals_are_blocked(self) -> None:
        blocked = [
            "/Flight_Data/credentials.json",
            "/Flight_Data/realtime-flight-tracker/backend.py",
            "/.git/config",
            "/start-website.bat",
            "/assets/../Flight_Data/credentials.json",
            "/assets/%2e%2e/Flight_Data/credentials.json",
        ]
        for path in blocked:
            with self.subTest(path=path):
                self.assertIsNone(TrackerRequestHandler._public_file(path))


class ExclusiveServerTests(unittest.TestCase):
    def test_second_server_cannot_bind_same_port(self) -> None:
        first = ExclusiveThreadingHTTPServer(("127.0.0.1", 0), TrackerRequestHandler)
        try:
            port = first.server_address[1]
            with self.assertRaises(OSError):
                duplicate = ExclusiveThreadingHTTPServer(("127.0.0.1", port), TrackerRequestHandler)
                duplicate.server_close()
        finally:
            first.server_close()


if __name__ == "__main__":
    unittest.main()
