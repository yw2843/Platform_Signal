from __future__ import annotations

import argparse
import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from backend import FlightTracker, OpenSkyClient, OpenSkyError, PollingService


APP_DIR = Path(__file__).resolve().parent
FLIGHT_DATA_DIR = APP_DIR.parent
DEFAULT_CREDENTIALS = FLIGHT_DATA_DIR / "credentials.json"
PLANE_MODEL = FLIGHT_DATA_DIR / "DC8_AFRC_AIR_0824.glb"


class TrackerRequestHandler(BaseHTTPRequestHandler):
    tracker: FlightTracker
    static_files = {
        "/": APP_DIR / "index.html",
        "/index.html": APP_DIR / "index.html",
        "/app.js": APP_DIR / "app.js",
        "/styles.css": APP_DIR / "styles.css",
        "/assets/plane.glb": PLANE_MODEL,
    }

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/flights":
            self._send_json(self.tracker.snapshot())
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

        file_path = self.static_files.get(path)
        if not file_path or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        self._send_file(file_path)

    def _send_json(self, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400" if path.suffix == ".glb" else "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        if self.path.startswith("/api/") and args and str(args[1]) == "200":
            return
        super().log_message(format, *args)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LGA real-time flight tracker")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="HTTP port (default: 8000)")
    parser.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    parser.add_argument("--no-poll", action="store_true", help="Serve the UI without contacting OpenSky")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    tracker = FlightTracker()
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
    print(f"LGA flight tracker: http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop.")
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

