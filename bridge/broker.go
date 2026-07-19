package main

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/bishopfox/sliver/protobuf/commonpb"
)

// broker ties the Sliver event stream to the WS hub. It forwards each raw event
// AND, on any session/beacon lifecycle event, pushes a fresh authoritative
// snapshot (re-querying GetSessions/GetBeacons). That spares clients from
// decoding beacons — which v1.7.3 delivers as protobuf bytes in Event.Data, not
// as a JSON field — and keeps their view consistent with the server.
type broker struct {
	client  *sliverClient
	hub     *hub
	refresh chan struct{}
}

func newBroker(c *sliverClient, h *hub) *broker {
	return &broker{client: c, hub: h, refresh: make(chan struct{}, 1)}
}

func (b *broker) run(ctx context.Context) {
	go b.snapshotLoop(ctx)
	go b.eventLoop(ctx)
}

// eventLoop subscribes to Sliver's Events RPC, reconnecting with backoff.
func (b *broker) eventLoop(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		stream, err := b.client.rpc.Events(ctx, &commonpb.Empty{})
		if err != nil {
			log.Printf("events: subscribe failed: %v (retry in %s)", err, backoff)
			sleepCtx(ctx, backoff)
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		log.Printf("events: subscribed to Sliver event stream")
		backoff = time.Second
		for {
			evt, err := stream.Recv()
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("events: stream ended: %v (reconnecting)", err)
				}
				break
			}
			// Any session/beacon change → refresh the authoritative snapshot.
			if isImplantEvent(evt.GetEventType()) {
				b.triggerRefresh()
			}
			// Forward only lifecycle notifications, and never task/command output:
			// strip Data/Job/Client so only the event type + session reaches the
			// browser (e.g. beacon-taskresult Data holds actual command output).
			if isLifecycleEvent(evt.GetEventType()) {
				evt.Data = nil
				evt.Job = nil
				evt.Client = nil
				if raw, err := marshalProto(evt); err == nil {
					env := make([]byte, 0, len(raw)+26)
					env = append(env, `{"kind":"event","event":`...)
					env = append(env, raw...)
					env = append(env, '}')
					b.hub.broadcast(env)
				}
			}
		}
		sleepCtx(ctx, backoff)
	}
}

// snapshotLoop coalesces refresh triggers and broadcasts a fresh snapshot.
func (b *broker) snapshotLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-b.refresh:
			sleepCtx(ctx, 300*time.Millisecond) // debounce bursts
			drain(b.refresh)
			if env, err := buildSnapshot(ctx, b.client); err == nil {
				b.hub.broadcast(env)
			}
		}
	}
}

func (b *broker) triggerRefresh() {
	select {
	case b.refresh <- struct{}{}:
	default: // already pending
	}
}

func drain(ch chan struct{}) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// isImplantEvent (broad) governs snapshot refreshes — any session/beacon change.
func isImplantEvent(t string) bool {
	return strings.Contains(t, "session") || strings.Contains(t, "beacon")
}

// isLifecycleEvent is the small allowlist of events safe to notify the browser
// about (with Data stripped) — never task results or other output-bearing events.
func isLifecycleEvent(t string) bool {
	switch t {
	case "session-connected", "session-disconnected", "beacon-registered":
		return true
	default:
		return false
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
