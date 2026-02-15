package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/opensandbox/opensandbox/internal/podman"
)

func main() {
	log.Println("opensandbox-worker: starting...")

	client, err := podman.NewClient()
	if err != nil {
		log.Fatalf("failed to initialize podman: %v", err)
	}

	ctx := context.Background()
	version, err := client.Version(ctx)
	if err != nil {
		log.Fatalf("failed to get podman version: %v", err)
	}
	log.Printf("opensandbox-worker: using podman %s", version)

	// TODO: Start gRPC server for control plane communication
	// For now, the worker functionality is embedded in the server (combined mode)
	log.Println("opensandbox-worker: running in standalone mode (gRPC server not yet implemented)")
	log.Println("opensandbox-worker: use --mode=combined on the server for single-machine deployment")

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("opensandbox-worker: shutting down...")
}
