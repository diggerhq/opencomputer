package config

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

// Config holds all configuration for the opencomputer server.
type Config struct {
	Port       int
	APIKey     string
	WorkerAddr string
	Mode       string // "server", "worker", "combined"
	LogLevel   string

	// Database
	DatabaseURL string // PostgreSQL connection string
	DataDir     string // Local data directory for SQLite files

	// Auth
	JWTSecret string // Shared secret for sandbox-scoped JWTs

	// NATS
	NATSURL string // NATS server URL

	// Worker identity
	Region   string // Region identifier (e.g., "iad", "ams")
	WorkerID string // Unique worker ID (e.g., "w-iad-1")
	HTTPAddr string // Public HTTP address for direct SDK access

	// WorkOS
	WorkOSAPIKey       string
	WorkOSClientID     string
	WorkOSRedirectURI  string
	WorkOSCookieDomain string
	WorkOSFrontendURL  string // e.g. "http://localhost:3000" for Vite dev

	// Redis (Upstash) for worker discovery
	RedisURL string

	// Worker capacity
	MaxCapacity int

	// Sandbox subdomain routing
	SandboxDomain string // Base domain for sandbox subdomains (e.g., "workers.opencomputer.dev", default "localhost")

	// S3-compatible object storage for checkpoint hibernation
	S3Endpoint        string // e.g. "https://<account>.r2.cloudflarestorage.com"
	S3Bucket          string // e.g. "opencomputer-checkpoints"
	S3Region          string // defaults to Region if not set
	S3AccessKeyID     string
	S3SecretAccessKey string
	S3ForcePathStyle  bool // true for R2/MinIO

	// ECR for template images
	ECRRegistry   string // e.g. "086971355112.dkr.ecr.us-east-2.amazonaws.com"
	ECRRepository string // e.g. "opencomputer-templates"

	// Sandbox resource defaults (overridable per-sandbox via API)
	DefaultSandboxMemoryMB int // default RAM per sandbox (MB), default 1024
	DefaultSandboxCPUs     int // default vCPUs per sandbox, default 1
	DefaultSandboxDiskMB   int // default disk quota per sandbox (MB), 0 = no quota

	// Firecracker microVM configuration (worker mode)
	FirecrackerBin string // Path to firecracker binary (default: "firecracker")
	KernelPath     string // Path to vmlinux kernel (default: $DataDir/firecracker/vmlinux-arm64)
	ImagesDir      string // Path to base rootfs images (default: $DataDir/firecracker/images/)

	// AWS EC2 compute pool (server mode only — for auto-scaling worker machines)
	EC2AMI             string // Custom AMI with Firecracker pre-installed
	EC2InstanceType    string // e.g. "c7gd.metal", "r6gd.metal", "r7gd.metal"
	EC2SubnetID        string // VPC subnet for worker instances
	EC2SecurityGroupID string // Security group (allow 8080, 9090, 9091)
	EC2KeyName             string // SSH key pair name (for debugging)
	EC2WorkerImage         string // Docker image for containerized workers
	EC2IAMInstanceProfile  string // IAM instance profile for worker instances (Secrets Manager + S3)

	// Cloudflare (custom hostname for org sandbox domains)
	CFAPIToken string // Cloudflare API token with Custom Hostnames permission
	CFZoneID   string // Cloudflare zone ID for the shared zone (e.g. opencomputer.dev)

	// Autoscaler
	ScaleCooldownSec int // Cooldown between scale-up actions (seconds), default 300

	// AWS Secrets Manager — if set, secrets are fetched at startup using IAM credentials.
	// The secret should be a JSON object with keys matching env var names (e.g. OPENCOMPUTER_JWT_SECRET).
	// Env vars take precedence over secret values (for local overrides).
	SecretsARN string
}

// Load reads configuration from environment variables with sensible defaults.
// If OPENCOMPUTER_SECRETS_ARN is set, secrets are fetched from AWS Secrets Manager
// first, then environment variables are applied on top (env vars take precedence).
func Load() (*Config, error) {
	// Fetch secrets from AWS Secrets Manager if configured.
	// This populates the process environment so subsequent os.Getenv calls pick them up.
	if arn := os.Getenv("OPENCOMPUTER_SECRETS_ARN"); arn != "" {
		if err := loadSecretsManager(arn); err != nil {
			return nil, fmt.Errorf("failed to load secrets from %s: %w", arn, err)
		}
	}

	cfg := &Config{
		Port:       8080,
		APIKey:     os.Getenv("OPENCOMPUTER_API_KEY"),
		WorkerAddr: envOrDefault("OPENCOMPUTER_WORKER_ADDR", "localhost:9090"),
		Mode:       envOrDefault("OPENCOMPUTER_MODE", "combined"),
		LogLevel:   envOrDefault("OPENCOMPUTER_LOG_LEVEL", "info"),

		DatabaseURL: envOrDefault("OPENCOMPUTER_DATABASE_URL", os.Getenv("DATABASE_URL")),
		DataDir:     envOrDefault("OPENCOMPUTER_DATA_DIR", "/data/sandboxes"),
		JWTSecret:   os.Getenv("OPENCOMPUTER_JWT_SECRET"),
		NATSURL:     envOrDefault("OPENCOMPUTER_NATS_URL", "nats://localhost:4222"),
		Region:      envOrDefault("OPENCOMPUTER_REGION", "local"),
		WorkerID:    envOrDefault("OPENCOMPUTER_WORKER_ID", "w-local-1"),
		HTTPAddr:    envOrDefault("OPENCOMPUTER_HTTP_ADDR", "http://localhost:8080"),

		WorkOSAPIKey:       os.Getenv("WORKOS_API_KEY"),
		WorkOSClientID:     os.Getenv("WORKOS_CLIENT_ID"),
		WorkOSRedirectURI:  envOrDefault("WORKOS_REDIRECT_URI", "http://localhost:8080/auth/callback"),
		WorkOSCookieDomain: os.Getenv("WORKOS_COOKIE_DOMAIN"),
		WorkOSFrontendURL:  os.Getenv("WORKOS_FRONTEND_URL"),

		RedisURL:    os.Getenv("OPENCOMPUTER_REDIS_URL"),

		MaxCapacity: envOrDefaultInt("OPENCOMPUTER_MAX_CAPACITY", 50),

		SandboxDomain: envOrDefault("OPENCOMPUTER_SANDBOX_DOMAIN", "localhost"),

		S3Endpoint:        os.Getenv("OPENCOMPUTER_S3_ENDPOINT"),
		S3Bucket:          os.Getenv("OPENCOMPUTER_S3_BUCKET"),
		S3Region:          os.Getenv("OPENCOMPUTER_S3_REGION"),
		S3AccessKeyID:     os.Getenv("OPENCOMPUTER_S3_ACCESS_KEY_ID"),
		S3SecretAccessKey: os.Getenv("OPENCOMPUTER_S3_SECRET_ACCESS_KEY"),
		S3ForcePathStyle:  os.Getenv("OPENCOMPUTER_S3_FORCE_PATH_STYLE") == "true",

		ECRRegistry:   os.Getenv("OPENCOMPUTER_ECR_REGISTRY"),
		ECRRepository: envOrDefault("OPENCOMPUTER_ECR_REPOSITORY", "opencomputer-templates"),

		DefaultSandboxMemoryMB: envOrDefaultInt("OPENCOMPUTER_DEFAULT_SANDBOX_MEMORY_MB", 1024),
		DefaultSandboxCPUs:     envOrDefaultInt("OPENCOMPUTER_DEFAULT_SANDBOX_CPUS", 1),
		DefaultSandboxDiskMB:   envOrDefaultInt("OPENCOMPUTER_DEFAULT_SANDBOX_DISK_MB", 0),

		FirecrackerBin: envOrDefault("OPENCOMPUTER_FIRECRACKER_BIN", "firecracker"),
		KernelPath:     os.Getenv("OPENCOMPUTER_KERNEL_PATH"),     // default derived from DataDir
		ImagesDir:      os.Getenv("OPENCOMPUTER_IMAGES_DIR"),      // default derived from DataDir

		EC2AMI:             os.Getenv("OPENCOMPUTER_EC2_AMI"),
		EC2InstanceType:    envOrDefault("OPENCOMPUTER_EC2_INSTANCE_TYPE", "c7gd.metal"),
		EC2SubnetID:        os.Getenv("OPENCOMPUTER_EC2_SUBNET_ID"),
		EC2SecurityGroupID: os.Getenv("OPENCOMPUTER_EC2_SECURITY_GROUP_ID"),
		EC2KeyName:         os.Getenv("OPENCOMPUTER_EC2_KEY_NAME"),
		EC2WorkerImage:         envOrDefault("OPENCOMPUTER_EC2_WORKER_IMAGE", "opencomputer-worker:latest"),
		EC2IAMInstanceProfile:  os.Getenv("OPENCOMPUTER_EC2_IAM_INSTANCE_PROFILE"),

		CFAPIToken: os.Getenv("OPENCOMPUTER_CF_API_TOKEN"),
		CFZoneID:   os.Getenv("OPENCOMPUTER_CF_ZONE_ID"),

		ScaleCooldownSec: envOrDefaultInt("OPENCOMPUTER_SCALE_COOLDOWN_SEC", 300),

		SecretsARN: os.Getenv("OPENCOMPUTER_SECRETS_ARN"),
	}

	// Default S3 region to worker region for same-region storage
	if cfg.S3Region == "" {
		cfg.S3Region = cfg.Region
	}

	if portStr := os.Getenv("OPENCOMPUTER_PORT"); portStr != "" {
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return nil, fmt.Errorf("invalid OPENCOMPUTER_PORT %q: %w", portStr, err)
		}
		cfg.Port = port
	}

	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrDefaultInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// loadSecretsManager fetches a JSON secret from AWS Secrets Manager and sets
// any values as environment variables (only if not already set, so explicit
// env vars always win). Uses the default AWS credential chain (IAM instance
// profile on EC2, or ~/.aws/credentials locally).
func loadSecretsManager(arn string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Extract region from ARN: arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME
	var opts []func(*awsconfig.LoadOptions) error
	if parts := strings.Split(arn, ":"); len(parts) >= 4 && parts[3] != "" {
		opts = append(opts, awsconfig.WithRegion(parts[3]))
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}

	client := secretsmanager.NewFromConfig(awsCfg)
	result, err := client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId: &arn,
	})
	if err != nil {
		return fmt.Errorf("GetSecretValue: %w", err)
	}

	if result.SecretString == nil {
		return fmt.Errorf("secret %s has no string value", arn)
	}

	var secrets map[string]string
	if err := json.Unmarshal([]byte(*result.SecretString), &secrets); err != nil {
		return fmt.Errorf("parse secret JSON: %w", err)
	}

	applied := 0
	for key, value := range secrets {
		if os.Getenv(key) == "" {
			os.Setenv(key, value)
			applied++
		}
	}

	log.Printf("config: loaded %d secrets from Secrets Manager (%d keys in secret, env overrides take precedence)", applied, len(secrets))
	return nil
}
