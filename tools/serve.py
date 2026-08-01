#!/usr/bin/env python3
"""Static server for local development. Sends no-store so ES module edits are
picked up on reload — browsers cache module graphs aggressively otherwise."""
import http.server, functools, sys, os

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()
    def log_message(self, *a): pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs')
os.chdir(root)
print(f"serving {os.getcwd()} on http://localhost:{port}")
http.server.ThreadingHTTPServer(('', port), NoCache).serve_forever()
