"""Lokal forhåndsvisning av portalen som oppdaterer seg selv når index.html endres.

    python forhandsvis.py          åpner http://localhost:8791

Siden pakkes inn som i make_site.py, og kortdata og bilder hentes fra mappa (cards.json, img/ …).
Nettleseren sjekker hvert sekund om index.html er endret, og laster siden på nytt når den er det.
Bare for utvikling på denne PC-en; den publiserte siden lages fortsatt av make_site.py på GitHub.
"""
import os
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from make_site import FOOT, HEAD

ROT = os.path.dirname(os.path.abspath(__file__))
PORT = 8791
LIVE = """<script>
(function () {
  let sist = null;
  async function sjekk() {
    try {
      const v = await (await fetch("/__versjon", { cache: "no-store" })).text();
      if (sist !== null && v !== sist) location.reload();
      sist = v;
    } catch (e) {}
    setTimeout(sjekk, 1000);
  }
  sjekk();
})();
</script>"""


def versjon():
    return str(os.path.getmtime(os.path.join(ROT, "index.html")))


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _svar(self, data, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        sti = self.path.split("?", 1)[0]
        if sti == "/__versjon":
            return self._svar(versjon().encode(), "text/plain")
        if sti in ("/", "/index.html"):
            with open(os.path.join(ROT, "index.html"), encoding="utf-8") as f:
                side = HEAD + f.read() + LIVE + FOOT
            return self._svar(side.encode("utf-8"), "text/html; charset=utf-8")
        return super().do_GET()


class Server(ThreadingHTTPServer):
    allow_reuse_address = False  # på Windows ville en ny start ellers dele porten med en gammel


def main():
    try:
        srv = Server(("127.0.0.1", PORT), partial(Handler, directory=ROT))
    except OSError:
        sys.exit(f"Forhåndsvisningen kjører allerede på http://localhost:{PORT}")
    url = f"http://localhost:{PORT}"
    print(f"Forhåndsvisning på {url}  (oppdaterer seg selv når index.html endres, Ctrl+C for å stoppe)")
    if "--ikke-åpne" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
