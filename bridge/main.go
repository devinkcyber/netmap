// netmap-sliver-bridge (milestone 1): a localhost-only, read-only bridge that
// connects to a Sliver server over mTLS gRPC and exposes /health, /sessions and
// /beacons as JSON for the netmap web app. No implant-interaction endpoints exist.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"net"
	"net/http"
)

func main() {
	configPath := flag.String("config", "operator.cfg", "path to your Sliver operator config (.cfg)")
	listen := flag.String("listen", "127.0.0.1:8888", "loopback address to serve the bridge on")
	allowOrigin := flag.String("allow-origin", "http://localhost:5173", "browser origin allowed to call the bridge")
	token := flag.String("token", "", "bearer token netmap must send (auto-generated if empty)")
	flag.Parse()

	// Refuse to bind anywhere but loopback — this speaks to a C2 server.
	if host, _, err := net.SplitHostPort(*listen); err != nil || !loopbackHost(host) {
		log.Fatalf("refusing to bind %q: bridge must listen on 127.0.0.1/localhost/::1", *listen)
	}

	cfg, err := loadOperatorConfig(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	client, err := connectSliver(cfg)
	if err != nil {
		log.Fatalf("sliver: %v", err)
	}

	tok := *token
	if tok == "" {
		tok = randomToken()
	}

	// Subscribe to Sliver's event stream once; the broker forwards events and
	// pushes fresh snapshots on lifecycle changes, fanning out via the hub.
	h := newHub()
	newBroker(client, h).run(context.Background())

	srv := &server{client: client, hub: h, token: tok, allowOrigin: *allowOrigin}

	log.Printf("netmap-sliver-bridge → Sliver %s:%d (operator %q)", cfg.LHost, cfg.LPort, cfg.Operator)
	log.Printf("listening on http://%s   (allowed origin: %s)", *listen, *allowOrigin)
	log.Printf("──────────────────────────────────────────────────────────")
	log.Printf(" BRIDGE TOKEN: %s", tok)
	log.Printf(" paste this into netmap's Sliver connection settings")
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
