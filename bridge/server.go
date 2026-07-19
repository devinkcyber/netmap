package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
)

type server struct {
	client      *sliverClient
	hub         *hub
	token       string
	allowOrigin string
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.corsAndHost(s.handleHealth)) // liveness, no token
	mux.HandleFunc("/sessions", s.guard(s.handleSessions))
	mux.HandleFunc("/beacons", s.guard(s.handleBeacons))
	mux.HandleFunc("/events", s.handleEvents) // WebSocket; auth via ?token=
	return mux
}

// corsAndHost enforces loopback Host (DNS-rebinding defense) and the Origin allowlist.
func (s *server) corsAndHost(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			http.Error(w, "bad host", http.StatusMisdirectedRequest)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			if origin != s.allowOrigin {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions { // CORS preflight
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

// guard = corsAndHost + bearer-token check.
func (s *server) guard(next http.HandlerFunc) http.HandlerFunc {
	return s.corsAndHost(func(w http.ResponseWriter, r *http.Request) {
		if !s.validToken(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	})
}

func (s *server) validToken(r *http.Request) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	_, err := s.client.version(ctx)
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "sliverConnected": err == nil})
}

func (s *server) handleSessions(w http.ResponseWriter, r *http.Request) {
	s.proxyProto(w, r, s.client.sessions)
}
func (s *server) handleBeacons(w http.ResponseWriter, r *http.Request) {
	s.proxyProto(w, r, s.client.beacons)
}

func (s *server) proxyProto(w http.ResponseWriter, r *http.Request, fn func(context.Context) (proto.Message, error)) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	msg, err := fn(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	b, err := marshalProto(msg)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
}

// handleEvents upgrades to a WebSocket and streams Sliver events. Browsers can't
// set headers on a WS handshake, so the token comes via ?token=.
func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !loopbackHost(r.Host) {
		http.Error(w, "bad host", http.StatusMisdirectedRequest)
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(s.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{originHost(s.allowOrigin)},
	})
	if err != nil {
		return // Accept already wrote the failure response
	}
	defer conn.CloseNow()

	ctx := conn.CloseRead(r.Context()) // read pump: detects close, discards inbound
	ch := s.hub.add()
	defer s.hub.remove(ch)

	s.sendSnapshot(ctx, conn) // best-effort initial state

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		case msg, ok := <-ch:
			if !ok {
				return
			}
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// sendSnapshot pushes the current sessions+beacons as the first WS message, so a
// client gets full state on connect without racing the event stream.
func (s *server) sendSnapshot(ctx context.Context, conn *websocket.Conn) {
	env, err := buildSnapshot(ctx, s.client)
	if err != nil {
		return
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_ = conn.Write(wctx, websocket.MessageText, env)
}

// buildSnapshot returns the snapshot envelope:
// {"kind":"snapshot","sessions":{"Sessions":[…]},"beacons":{"Beacons":[…]}}
func buildSnapshot(ctx context.Context, c *sliverClient) ([]byte, error) {
	sctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	sess, err := c.sessions(sctx)
	if err != nil {
		return nil, err
	}
	beac, err := c.beacons(sctx)
	if err != nil {
		return nil, err
	}
	sb, err := marshalProto(sess)
	if err != nil {
		return nil, err
	}
	bb, err := marshalProto(beac)
	if err != nil {
		return nil, err
	}
	env := make([]byte, 0, len(sb)+len(bb)+48)
	env = append(env, `{"kind":"snapshot","sessions":`...)
	env = append(env, sb...)
	env = append(env, `,"beacons":`...)
	env = append(env, bb...)
	env = append(env, '}')
	return env, nil
}

func originHost(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return rawURL
	}
	return u.Host
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func loopbackHost(host string) bool {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	h = strings.Trim(h, "[]")
	return h == "127.0.0.1" || h == "localhost" || h == "::1"
}
