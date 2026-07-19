// wstest is a dev-only client that connects to the bridge's /events WebSocket and
// prints the snapshot + each event, so you can inspect the live feed without
// installing a separate WS tool. Run from the bridge dir:
//
//	go run ./cmd/wstest --token <BRIDGE TOKEN> --url ws://127.0.0.1:8899/events
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"

	"github.com/coder/websocket"
)

func main() {
	url := flag.String("url", "ws://127.0.0.1:8888/events", "bridge /events URL")
	token := flag.String("token", "", "bridge token (printed on bridge startup)")
	origin := flag.String("origin", "http://localhost:5173", "Origin header to send")
	flag.Parse()
	if *token == "" {
		fmt.Fprintln(os.Stderr, "need --token <BRIDGE TOKEN>")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	hdr := http.Header{}
	hdr.Set("Origin", *origin)
	c, resp, err := websocket.Dial(ctx, *url+"?token="+*token, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		code := 0
		if resp != nil {
			code = resp.StatusCode
		}
		fmt.Fprintf(os.Stderr, "dial failed (http %d): %v\n", code, err)
		os.Exit(1)
	}
	defer c.CloseNow()
	c.SetReadLimit(64 * 1024 * 1024) // big snapshots

	fmt.Println("connected — first message is the snapshot; events follow (Ctrl-C to quit)")
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "read ended: %v\n", err)
			return
		}
		fmt.Printf("\n%s\n", data)
	}
}
