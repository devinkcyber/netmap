// netmap-vault-bridge: a localhost-only helper that reads and writes an Obsidian
// vault directory and exposes it as a small JSON API. netmap uses it as the vault
// backend on browsers without the File System Access API (Firefox, Safari); Chromium
// browsers can talk to a vault directly and don't need this.
//
// It is loopback-only, bearer-token authed, origin-allowlisted, rejects non-loopback
// Host headers (a DNS-rebinding defence), and sandboxes every path to the vault root.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

func main() {
	vaultDir := flag.String("vault", "", "path to your Obsidian vault directory (required)")
	listen := flag.String("listen", "127.0.0.1:8899", "loopback address to serve the bridge on")
	allowOrigin := flag.String("allow-origin", "http://localhost:5173", "browser origin allowed to call the bridge")
	token := flag.String("token", "", "bearer token netmap must send (auto-generated if empty)")
	flag.Parse()

	if *vaultDir == "" {
		log.Fatalf("--vault is required (path to your Obsidian vault directory)")
	}
	// Refuse to bind anywhere but loopback — this exposes read/write to your files.
	if host, _, err := net.SplitHostPort(*listen); err != nil || !loopbackHost(host) {
		log.Fatalf("refusing to bind %q: bridge must listen on 127.0.0.1/localhost/::1", *listen)
	}

	root, err := filepath.Abs(*vaultDir)
	if err != nil {
		log.Fatalf("vault path: %v", err)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		log.Fatalf("vault path %q is not a directory", root)
	}

	tok := *token
	if tok == "" {
		tok = randomToken()
	}

	srv := &server{root: root, token: tok, allowOrigin: *allowOrigin}

	log.Printf("netmap-vault-bridge → vault %q", root)
	log.Printf("listening on http://%s   (allowed origin: %s)", *listen, *allowOrigin)
	log.Printf("──────────────────────────────────────────────────────────")
	log.Printf(" BRIDGE TOKEN: %s", tok)
	log.Printf(" paste this + the URL into netmap's \"Connect vault\" dialog")
	log.Printf("──────────────────────────────────────────────────────────")

	httpSrv := &http.Server{Addr: *listen, Handler: srv.routes()}
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
