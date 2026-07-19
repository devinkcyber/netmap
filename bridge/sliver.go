package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/rpcpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// operatorConfig mirrors the subset of a Sliver operator `.cfg` we need.
type operatorConfig struct {
	Operator      string `json:"operator"`
	LHost         string `json:"lhost"`
	LPort         int    `json:"lport"`
	Token         string `json:"token"`
	CACertificate string `json:"ca_certificate"`
	Certificate   string `json:"certificate"`
	PrivateKey    string `json:"private_key"`
}

func loadOperatorConfig(path string) (*operatorConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg operatorConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config (expected a Sliver operator .cfg): %w", err)
	}
	if cfg.LHost == "" || cfg.LPort == 0 || cfg.Certificate == "" || cfg.PrivateKey == "" || cfg.CACertificate == "" {
		return nil, errors.New("config missing required fields (lhost/lport/certificate/private_key/ca_certificate)")
	}
	return &cfg, nil
}

// sliverClient wraps the mTLS gRPC connection + the SliverRPC stub.
type sliverClient struct {
	cfg  *operatorConfig
	conn *grpc.ClientConn
	rpc  rpcpb.SliverRPCClient
}

// Sliver implants can return large blobs; match the client's generous recv cap.
const maxMsgSize = 2*1024*1024*1024 - 1 // 2 GiB - 1

func connectSliver(cfg *operatorConfig) (*sliverClient, error) {
	tlsCfg, err := mtlsConfig(cfg)
	if err != nil {
		return nil, err
	}
	addr := fmt.Sprintf("%s:%d", cfg.LHost, cfg.LPort)
	// grpc.NewClient connects lazily (the replacement for the deprecated DialContext,
	// which we relied on for its non-blocking behavior); /health probes the link.
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)),
		grpc.WithPerRPCCredentials(tokenAuth{token: cfg.Token}),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxMsgSize)),
	)
	if err != nil {
		return nil, fmt.Errorf("dial sliver: %w", err)
	}
	return &sliverClient{cfg: cfg, conn: conn, rpc: rpcpb.NewSliverRPCClient(conn)}, nil
}

// mtlsConfig builds the operator's mTLS config. Sliver server certs are CA-signed
// but their SAN doesn't match `lhost`, so (like the Sliver client) we skip the
// default hostname check and validate the chain against the CA ourselves.
func mtlsConfig(cfg *operatorConfig) (*tls.Config, error) {
	cert, err := tls.X509KeyPair([]byte(cfg.Certificate), []byte(cfg.PrivateKey))
	if err != nil {
		return nil, fmt.Errorf("operator keypair: %w", err)
	}
	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM([]byte(cfg.CACertificate)) {
		return nil, errors.New("invalid ca_certificate in config")
	}
	return &tls.Config{
		Certificates:       []tls.Certificate{cert},
		RootCAs:            caPool,
		InsecureSkipVerify: true, // hostname check disabled; chain verified below
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return errors.New("server presented no certificate")
			}
			leaf, err := x509.ParseCertificate(rawCerts[0])
			if err != nil {
				return err
			}
			_, err = leaf.Verify(x509.VerifyOptions{Roots: caPool})
			return err
		},
	}, nil
}

// tokenAuth sends the operator token as per-RPC metadata, as the Sliver server expects.
type tokenAuth struct{ token string }

func (t tokenAuth) GetRequestMetadata(_ context.Context, _ ...string) (map[string]string, error) {
	return map[string]string{"Authorization": "Bearer " + t.token}, nil
}
func (tokenAuth) RequireTransportSecurity() bool { return true }

// --- read-only RPC wrappers (return raw proto messages for JSON passthrough) ---

func (c *sliverClient) version(ctx context.Context) (proto.Message, error) {
	resp, err := c.rpc.GetVersion(ctx, &commonpb.Empty{})
	return resp, err
}
func (c *sliverClient) sessions(ctx context.Context) (proto.Message, error) {
	resp, err := c.rpc.GetSessions(ctx, &commonpb.Empty{})
	return resp, err
}
func (c *sliverClient) beacons(ctx context.Context) (proto.Message, error) {
	resp, err := c.rpc.GetBeacons(ctx, &commonpb.Empty{})
	return resp, err
}

// Marshal protobuf → JSON using the original proto field names, so netmap sees a
// stable, version-robust shape (e.g. {"Sessions":[{"Hostname":...,"OS":...}]}).
var jsonMarshaler = protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}

func marshalProto(m proto.Message) ([]byte, error) {
	return jsonMarshaler.Marshal(m)
}
