from __future__ import annotations

import argparse
import json
import math
import mimetypes
import socket
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from backend import FlightTracker, OpenSkyClient, OpenSkyError, PollingService
from v2_signal import OpenMapTilesBuildingProvider


APP_DIR = Path(__file__).resolve().parent
FLIGHT_DATA_DIR = APP_DIR.parent
PROJECT_ROOT = FLIGHT_DATA_DIR.parent
DEFAULT_CREDENTIALS = FLIGHT_DATA_DIR / "credentials.json"
PLANE_MODEL = FLIGHT_DATA_DIR / "DC8_AFRC_AIR_0824.glb"
PUBLIC_ROOT_NAMES = {"assets", "RouteShape", "Source"}
PUBLIC_SUFFIXES = {
    ".css",
    ".csv",
    ".geojson",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".png",
    ".svg",
    ".webp",
    ".woff",
    ".woff2",
}


class TrackerRequestHandler(BaseHTTPRequestHandler):
    tracker: FlightTracker

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/flights":
            self._send_json(self.tracker.snapshot())
            return
        if path == "/api/signal-v2":
            query = parse_qs(parsed.query)
            icao24 = str((query.get("icao24") or [""])[0]).strip().lower()
            if not icao24:
                self._send_json({"error": "icao24 is required"}, HTTPStatus.BAD_REQUEST)
                return
            since: float | None = None
            if query.get("since"):
                try:
                    since = float(query["since"][0])
                except (TypeError, ValueError):
                    self._send_json({"error": "since must be a Unix timestamp"}, HTTPStatus.BAD_REQUEST)
                    return
                if not math.isfinite(since):
                    self._send_json({"error": "since must be a finite Unix timestamp"}, HTTPStatus.BAD_REQUEST)
                    return
            history = self.tracker.signal_history(icao24, since)
            if history is None:
                self._send_json({"error": "flight not found"}, HTTPStatus.NOT_FOUND)
                return
            self._send_json(history)
            return
        if path == "/api/health":
            snapshot = self.tracker.snapshot()
            self._send_json(
                {
                    "state": snapshot["service"]["state"],
                    "message": snapshot["service"]["message"],
                    "source_time": snapshot["source_time"],
                    "flight_count": len(snapshot["flights"]),
                }
            )
            return

        file_path = self._public_file(path)
        if not file_path or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        self._send_file(file_path)

    @staticmethod
    def _public_file(request_path: str) -> Path | None:
        """Resolve only explicitly public website assets.

        Flight_Data/credentials.json and all other project paths are intentionally
        outside this allowlist, even when the server listens on the local network.
        """
        path = unquote(request_path)
        if path in {"/", "/index.html"}:
            return PROJECT_ROOT / "index.html"
        if path == "/assets/plane.glb":
            return PLANE_MODEL
        if "\\" in path or "\x00" in path:
            return None
        relative = Path(path.lstrip("/"))
        if not relative.parts or relative.parts[0] not in PUBLIC_ROOT_NAMES:
            return None
        if any(part in {"", ".", ".."} for part in relative.parts):
            return None
        if relative.suffix.lower() not in PUBLIC_SUFFIXES:
            return None
        candidate = (PROJECT_ROOT / relative).resolve()
        public_root = (PROJECT_ROOT / relative.parts[0]).resolve()
        try:
            candidate.relative_to(public_root)
        except ValueError:
            return None
        return candidate

    def _send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        body = path.read_bytes()
        content_type = "model/gltf-binary" if path.suffix.lower() == ".glb" else (
            mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        )
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400" if path.suffix == ".glb" else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        if self.path.startswith("/api/") and args and str(args[1]) == "200":
            return
        super().log_message(format, *args)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Platform Signal integrated local server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="HTTP port (default: 8000)")
    parser.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    parser.add_argument("--no-poll", action="store_true", help="Serve the UI without contacting OpenSky")
    parser.add_argument("--open-browser", action="store_true", help="Open the integrated website locally")
    return parser.parse_args()


def local_ipv4_addresses() -> list[str]:
    addresses: set[str] = set()
    try:
        for entry in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = entry[4][0]
            if address and not address.startswith("127.") and not address.startswith("169.254."):
                addresses.add(address)
    except OSError:
        pass
    return sorted(addresses)


def main() -> int:
    args = parse_args()
    tracker = FlightTracker(building_provider=OpenMapTilesBuildingProvider())
    poller: PollingService | None = None

    if args.no_poll:
        tracker.update_service_status(state="offline", message="OpenSky polling disabled by --no-poll")
    else:
        try:
            client = OpenSkyClient(args.credentials.resolve())
        except OpenSkyError as exc:
            tracker.update_service_status(state="error", message=str(exc))
        else:
            poller = PollingService(tracker, client)
            poller.start()

    TrackerRequestHandler.tracker = tracker
    server = ThreadingHTTPServer((args.host, args.port), TrackerRequestHandler)
    server.daemon_threads = True
    print(f"Platform Signal local URL: http://127.0.0.1:{args.port}")
    if args.host in {"0.0.0.0", "::"}:
        addresses = local_ipv4_addresses()
        if addresses:
            for address in addresses:
                print(f"Platform Signal LAN URL:   http://{address}:{args.port}")
        else:
            print("LAN URL: run ipconfig and use this laptop's IPv4 address with port 8000.")
        print("LAN access is limited by the Windows Private-network firewall rule.")
    print("Sensitive files, including Flight_Data/credentials.json, are not web-accessible.")
    print("Press Ctrl+C to stop.")
    if args.open_browser:
        threading.Timer(0.8, webbrowser.open, args=(f"http://127.0.0.1:{args.port}",)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping tracker...")
    finally:
        server.server_close()
        if poller:
            poller.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
