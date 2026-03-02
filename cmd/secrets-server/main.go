package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opensandbox/opensandbox/internal/config"
	"github.com/opensandbox/opensandbox/internal/crypto"
	"github.com/opensandbox/opensandbox/internal/secrets"
	pb "github.com/opensandbox/opensandbox/proto/secrets"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("secrets-server: failed to load config: %v", err)
	}

	if cfg.DatabaseURL == "" {
		log.Fatal("secrets-server: OPENSANDBOX_DATABASE_URL is required")
	}
	if cfg.EncryptionKeys == "" {
		log.Fatal("secrets-server: OPENSANDBOX_ENCRYPTION_KEYS is required")
	}

	keyRing, err := crypto.NewKeyRing(cfg.EncryptionKeys)
	if err != nil {
		log.Fatalf("secrets-server: invalid encryption keys: %v", err)
	}
	log.Printf("secrets-server: encryption key ring loaded (active version: %s)", keyRing.ActiveVersion())

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	cancel()
	if err != nil {
		log.Fatalf("secrets-server: failed to connect to database: %v", err)
	}
	defer pool.Close()

	// Verify connectivity
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("secrets-server: database ping failed: %v", err)
	}
	cancel()
	log.Println("secrets-server: connected to PostgreSQL")

	store := secrets.NewStore(pool, keyRing)
	srv := secrets.NewServer(store)

	// Build gRPC server options
	var serverOpts []grpc.ServerOption

	// Chain interceptors: logging (always) + auth (if configured)
	var interceptors []grpc.UnaryServerInterceptor
	interceptors = append(interceptors, secrets.LoggingInterceptor())

	if cfg.SecretsAPIKey != "" {
		keyHash := secrets.HashAPIKey(cfg.SecretsAPIKey)
		interceptors = append(interceptors, secrets.APIKeyInterceptor(keyHash))
		log.Println("secrets-server: API key authentication enabled")
	} else {
		log.Println("secrets-server: WARNING — no API key configured, gRPC is unauthenticated")
	}
	serverOpts = append(serverOpts, grpc.ChainUnaryInterceptor(interceptors...))

	// TLS transport
	if cfg.SecretsTLSCert != "" && cfg.SecretsTLSKey != "" {
		cert, err := tls.LoadX509KeyPair(cfg.SecretsTLSCert, cfg.SecretsTLSKey)
		if err != nil {
			log.Fatalf("secrets-server: failed to load TLS cert/key: %v", err)
		}
		tlsCreds := credentials.NewTLS(&tls.Config{Certificates: []tls.Certificate{cert}})
		serverOpts = append(serverOpts, grpc.Creds(tlsCreds))
		log.Println("secrets-server: TLS enabled")
	} else {
		log.Println("secrets-server: WARNING — TLS not configured, gRPC traffic is unencrypted")
	}

	grpcServer := grpc.NewServer(serverOpts...)
	pb.RegisterSecretsServiceServer(grpcServer, srv)

	addr := fmt.Sprintf(":%d", cfg.SecretsGRPCPort)
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("secrets-server: failed to listen on %s: %v", addr, err)
	}

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("secrets-server: listening on %s", addr)
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatalf("secrets-server: gRPC serve error: %v", err)
		}
	}()

	<-quit
	log.Println("secrets-server: shutting down...")
	grpcServer.GracefulStop()
	log.Println("secrets-server: stopped")
}
