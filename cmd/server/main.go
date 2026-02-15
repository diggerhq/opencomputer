package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"syscall"

	"github.com/opensandbox/opensandbox/internal/api"
	"github.com/opensandbox/opensandbox/internal/config"
	"github.com/opensandbox/opensandbox/internal/podman"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/template"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	podmanClient, err := podman.NewClient()
	if err != nil {
		log.Fatalf("failed to initialize podman: %v", err)
	}

	// Verify podman is working
	ctx := context.Background()
	version, err := podmanClient.Version(ctx)
	if err != nil {
		log.Fatalf("failed to get podman version: %v", err)
	}
	log.Printf("opensandbox: using podman %s", version)

	// Initialize sandbox manager
	mgr := sandbox.NewManager(podmanClient)
	defer mgr.Close()

	// Initialize PTY manager
	podmanPath, _ := exec.LookPath("podman")
	ptyMgr := sandbox.NewPTYManager(podmanPath, podmanClient.AuthFile())
	defer ptyMgr.CloseAll()

	// Initialize template system
	registry := template.NewRegistry()
	builder := template.NewBuilder(podmanClient, registry)

	// Create API server
	server := api.NewServer(mgr, ptyMgr, cfg.APIKey)
	server.SetTemplateDeps(registry, builder)

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("opensandbox: starting server on %s (mode=%s)", addr, cfg.Mode)

	go func() {
		if err := server.Start(addr); err != nil {
			log.Printf("server error: %v", err)
		}
	}()

	<-quit
	log.Println("opensandbox: shutting down...")
	if err := server.Close(); err != nil {
		log.Printf("error closing server: %v", err)
	}
}
