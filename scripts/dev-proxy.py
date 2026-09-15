"""Local dev proxy mirroring vercel.json's /radio/* rewrite, so docs/ (the static site) and a
locally running radio/server.py can be browsed together on one origin, exactly like production --
no deploy needed. Home, Research, Radio etc. all navigate correctly; the radio page's own API
calls (pcm/captions/shows.json, now page-relative -- see radio/site.html) proxy straight through.

    python radio/server.py            # in one terminal
    python scripts/dev-proxy.py       # in another
    # then open http://localhost:4321/

    python scripts/dev-proxy.py --port 4321 --radio-port 8790
"""
from __future__ import annotations

import argparse
import http.client
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"
HOP_BY_HOP = {"connection", "transfer-encoding", "keep-alive", "proxy-authenticate",
              "proxy-authorization", "te", "trailers", "upgrade"}


def _handler(radio_host: str, radio_port: int):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path == "/radio":
                return self._redirect("/radio/")
            if self.path.startswith("/radio/"):
                return self._proxy(self.path[len("/radio"):])
            self._serve_static(self.path)

        def _redirect(self, to: str) -> None:
            self.send_response(308)
            self.send_header("Location", to)
            self.end_headers()

        def _proxy(self, backend_path: str) -> None:
            """Forwards to radio/server.py and streams the response back chunk by chunk -- a
            plain buffer-then-send wouldn't work for /pcm/<show> (infinite audio) or /captions
            (server-sent events), both long-lived."""
            try:
                conn = http.client.HTTPConnection(radio_host, radio_port, timeout=30)
                conn.request("GET", backend_path or "/")
                resp = conn.getresponse()
            except OSError:
                self.send_response(502)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                msg = f"radio backend not reachable -- is `python radio/server.py` running on {radio_host}:{radio_port}?"
                self.wfile.write(msg.encode())
                return
            try:
                self.send_response(resp.status)
                for k, v in resp.getheaders():
                    if k.lower() not in HOP_BY_HOP:
                        self.send_header(k, v)
                self.end_headers()
                while True:
                    chunk = resp.read(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                conn.close()

        def _serve_static(self, path: str) -> None:
            path = path.split("?", 1)[0].split("#", 1)[0]
            fs_path = (DOCS / "index.html") if path == "/" else (DOCS / path.lstrip("/"))
            fs_path = fs_path.resolve()
            if fs_path.is_dir():
                fs_path = fs_path / "index.html"
            if DOCS not in fs_path.parents:
                return self.send_error(403)
            if not fs_path.is_file():
                return self.send_error(404)
            ctype = mimetypes.guess_type(str(fs_path))[0] or "application/octet-stream"
            body = fs_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=4321)
    p.add_argument("--radio-host", default="127.0.0.1")
    p.add_argument("--radio-port", type=int, default=8790)
    args = p.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), _handler(args.radio_host, args.radio_port))
    print(f"dev-proxy: http://127.0.0.1:{args.port}/  "
          f"(proxying /radio/* -> http://{args.radio_host}:{args.radio_port}/)")
    server.serve_forever()


if __name__ == "__main__":
    main()
