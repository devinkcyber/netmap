package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type server struct {
	root        string // absolute path to the vault directory
	token       string
	allowOrigin string
}

// Cap on a single note/attachment write, so a runaway request can't fill the disk.
const maxWriteBytes = 64 << 20 // 64 MiB

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.corsAndHost(s.handleHealth)) // liveness, no token
	mux.HandleFunc("/vault", s.guard(s.handleVault))         // vault name
	mux.HandleFunc("/notes", s.guard(s.handleNotes))         // list *.md + frontmatter head
	mux.HandleFunc("/file", s.guard(s.handleFile))           // GET/PUT text
	mux.HandleFunc("/blob", s.guard(s.handleBlob))           // GET/PUT binary (attachments)
	return mux
}

// corsAndHost enforces loopback Host (DNS-rebinding defence) and the Origin allowlist.
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
			w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
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

// safePath maps a vault-relative (forward-slash) path to an absolute path, refusing
// anything that would escape the vault root (`..`, absolute paths, etc.).
func (s *server) safePath(rel string) (string, error) {
	if rel == "" {
		return "", errors.New("empty path")
	}
	// Treat the input as rooted so Clean collapses any `..` without climbing above /,
	// then join onto the vault root and re-check the prefix as defence in depth.
	clean := filepath.Clean("/" + filepath.FromSlash(rel))
	abs := filepath.Join(s.root, clean)
	if abs != s.root && !strings.HasPrefix(abs, s.root+string(os.PathSeparator)) {
		return "", errors.New("path escapes vault")
	}
	return abs, nil
}

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "vault": filepath.Base(s.root)})
}

func (s *server) handleVault(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"name": filepath.Base(s.root)})
}

// handleNotes walks the vault (skipping dotfolders like .obsidian/.trash) and returns
// every *.md file's vault-relative path plus the first 2 KiB (enough for frontmatter).
func (s *server) handleNotes(w http.ResponseWriter, _ *http.Request) {
	type note struct {
		Path string `json:"path"`
		Head string `json:"head"`
	}
	notes := []note{}
	_ = filepath.WalkDir(s.root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != s.root && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			return nil
		}
		rel, relErr := filepath.Rel(s.root, p)
		if relErr != nil {
			return nil
		}
		notes = append(notes, note{Path: filepath.ToSlash(rel), Head: readHead(p, 2000)})
		return nil
	})
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes})
}

func (s *server) handleFile(w http.ResponseWriter, r *http.Request) {
	p, err := s.safePath(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		b, err := os.ReadFile(p)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write(b)
	case http.MethodPut:
		s.writeFile(w, r, p)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) handleBlob(w http.ResponseWriter, r *http.Request) {
	p, err := s.safePath(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		b, err := os.ReadFile(p)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(b)
	case http.MethodPut:
		s.writeFile(w, r, p)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) writeFile(w http.ResponseWriter, r *http.Request, p string) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWriteBytes))
	if err != nil {
		http.Error(w, "read body failed", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		http.Error(w, "mkdir failed", http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(p, body, 0o644); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// readHead returns up to n bytes from the start of a file (best-effort, "" on error).
func readHead(path string, n int) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, n)
	got, _ := io.ReadFull(f, buf)
	return string(buf[:got])
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
