"""Run the site locally, with areas that no place covers built on request.

    python -m pipeline.serve              # http://localhost:8000
    python -m pipeline.serve --port 8080

It serves web/ like any static server, plus the small API the map uses when
someone looks up an address that no place covers. On the live site the same
API is functions/api/[[path]].js on Cloudflare Pages.

    GET  /api/area?lat=..&lon=..   what is known about the area around a spot
    POST /api/area?lat=..&lon=..   the same, and start building it if needed

Answers are JSON with a "status":

    ready      built: "meta" is its index entry, "base" where its files are
    building   being built: "step" says what it is doing, "started" since when
    failed     cannot be built now: "code" and "reason" say why
    none       not built and not asked for (GET only)
    busy       too many areas waiting, try again later (POST only)

Builds run one at a time, each in its own process (python -m pipeline.area),
and need the Earthdata token the pipeline needs (EARTHDATA_TOKEN). With
--offline nothing is downloaded: areas are built from the radar windows already
in data_cache/areas, which is how to rebuild them after changing the pipeline.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import area as A

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
LOGS = A.RAW / "logs"
MAX_WAITING = 6


class Builds:
    """Areas waiting or being built, worked through one at a time."""

    def __init__(self, out, offline=False):
        self.out = Path(out)
        self.offline = offline
        self.lock = threading.Lock()
        self.jobs = {}          # id -> dict(lat, lon, started, log, proc)
        self.order = []         # ids, oldest first
        self.crashed = {}       # id -> (time, reason) for builds that died
        self.wake = threading.Event()
        threading.Thread(target=self._work, daemon=True).start()

    def status(self, c, start=False):
        meta = A.read_meta(self.out / c["id"])
        if meta and meta.get("status") == "ready":
            return dict(status="ready", id=c["id"], base=f"data/areas/{c['id']}/", meta=meta)
        if A.is_current(meta):
            return dict(status="failed", id=c["id"], code=meta.get("code", "error"), reason=meta.get("reason", ""))
        with self.lock:
            job = self.jobs.get(c["id"])
            if job:
                return self._building(c["id"], job)
            crash = self.crashed.get(c["id"])
            if crash and time.time() - crash[0] < 600:
                return dict(status="failed", id=c["id"], code="error", reason=crash[1])
            if not start:
                return dict(status="none", id=c["id"])
            if len(self.order) >= MAX_WAITING:
                return dict(status="busy", id=c["id"], reason="Too many areas are waiting to be built.")
            job = self.jobs[c["id"]] = dict(lat=c["lat"], lon=c["lon"], started=time.time(),
                                            log=LOGS / f"{c['id']}.log", proc=None)
            self.order.append(c["id"])
            self.wake.set()
            return self._building(c["id"], job)

    def _building(self, area_id, job):
        ahead = self.order.index(area_id)
        step = "Waiting for " + (f"{ahead} other area{'s' if ahead > 1 else ''}" if ahead else "a free worker")
        if job["proc"] is not None:
            step = "Starting"
            try:
                lines = [l for l in job["log"].read_text().splitlines() if l.startswith("> ")]
                step = lines[-1][2:] if lines else step
            except OSError:
                pass
        started = datetime.fromtimestamp(job["started"], timezone.utc).isoformat(timespec="seconds")
        return dict(status="building", id=area_id, step=step, started=started)

    def _work(self):
        while True:
            self.wake.wait()
            with self.lock:
                if not self.order:
                    self.wake.clear()
                    continue
                area_id = self.order[0]
                job = self.jobs[area_id]
                LOGS.mkdir(parents=True, exist_ok=True)
                log = job["log"].open("w")
                job["proc"] = subprocess.Popen(
                    [sys.executable, "-m", "pipeline.area", "--lat", str(job["lat"]), "--lon", str(job["lon"]),
                     "--out", str(self.out)] + (["--offline"] if self.offline else []),
                    cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            code = job["proc"].wait()
            log.close()
            print(f"area {area_id}: build finished with exit code {code}, log in {job['log']}", flush=True)
            with self.lock:
                if code != 0:
                    said = [l[2:] for l in job["log"].read_text().splitlines() if l.startswith("> ")]
                    self.crashed[area_id] = (time.time(), said[-1] if said else "The build stopped with an error.")
                self.order.remove(area_id)
                del self.jobs[area_id]


class Handler(SimpleHTTPRequestHandler):
    builds: Builds = None

    def end_headers(self):
        # the map data changes when the pipeline runs: do not let the browser keep old copies
        if self.path.startswith("/data/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/api/area":
            return self.api(start=False)
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path == "/api/area":
            return self.api(start=True)
        self.send_error(405)

    def api(self, start):
        q = parse_qs(urlparse(self.path).query)
        try:
            c = A.snap(float(q["lat"][0]), float(q["lon"][0]))
        except (KeyError, ValueError):
            return self.reply(400, dict(status="error", reason="lat and lon are needed, in degrees"))
        return self.reply(200, self.builds.status(c, start))

    def reply(self, code, body):
        data = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--offline", action="store_true",
                    help="build areas from the radar windows in data_cache/areas, without downloading")
    a = ap.parse_args(argv)
    Handler.builds = Builds(A.OUT, a.offline)
    server = ThreadingHTTPServer((a.host, a.port), partial(Handler, directory=str(WEB)))
    print(f"serving http://{a.host}:{a.port} (areas built on request go to {A.OUT})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
