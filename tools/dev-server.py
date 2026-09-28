#!/usr/bin/env python3
"""Development server for TaskApp.

    python3 tools/dev-server.py            # http://localhost:8000
    python3 tools/dev-server.py 8080

`python3 -m http.server` is not good enough here (lesson carried over from ScheduleApp):

1. **HTTP caching.** `http.server` sends `Last-Modified` and no `Cache-Control`, so
   browsers apply heuristic caching and may reuse a file without revalidating. Every
   response here is `no-store`, so a reload always fetches.

2. **A stale service worker.** This is the nastier one. A cache-first worker *serves the
   app*, so once a broken or outdated version is installed it hands out its own cached
   copy indefinitely — including the very code that would unregister it. The app no
   longer registers a worker on localhost, but that fix can never reach a browser the
   old worker is already serving.

   So on localhost this server answers `/sw.js` with a **kill switch**: a worker that
   deletes every cache, unregisters itself, and reloads open tabs. Browsers always check
   `/sw.js` over the network on navigation, bypassing the worker, so the stale one gets
   replaced by this and disappears. A browser with no worker installed is unaffected.

   Production serves the real `sw.js` from disk, which is what makes the app installable
   and offline-capable. This substitution is localhost-only and never deployed.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Replaces the real service worker on localhost. No fetch handler, so nothing is
# intercepted; it exists purely to undo whatever was installed before it.
KILL_SWITCH_SW = b"""/* dev kill switch - see tools/dev-server.py. Not the real sw.js. */
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key)
    await self.registration.unregister()
    // Reload open tabs so they pick up files from the network rather than from the
    // cache this worker was serving a moment ago.
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url)
    }
  })())
})
"""

LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}


class DevHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Never let the browser reuse a file without asking.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_head(self):
        if self.path.split("?")[0] in ("/sw.js", "/sw.js/") and self._is_local():
            return self._serve_kill_switch()
        return super().send_head()

    def _is_local(self):
        host = self.headers.get("Host", "").rsplit(":", 1)[0]
        return host in LOCAL_HOSTS

    def _serve_kill_switch(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/javascript")
        self.send_header("Content-Length", str(len(KILL_SWITCH_SW)))
        self.end_headers()
        # send_head's contract is to return a readable body for the caller to copy.
        import io
        return io.BytesIO(KILL_SWITCH_SW)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = partial(DevHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("", port), handler)

    print(f"TaskApp dev server — {ROOT}")
    print(f"  app    http://localhost:{port}/")
    print(f"  tests  http://localhost:{port}/test/")
    print()
    print("  no-store on every response; /sw.js is a kill switch on localhost,")
    print("  so a stale service worker cannot survive a reload.")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
