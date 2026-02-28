.PHONY: build run test fmt lint clean help

# Build variables
BINARY_SERVER = opencomputer-server
BINARY_WORKER = opencomputer-worker
BINARY_AGENT = osb-agent
BUILD_DIR = bin

## help: Show this help message
help:
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/## //' | column -t -s ':'

## build: Build server, worker, and agent binaries
build: build-server build-worker build-agent

## build-server: Build the control plane server
build-server:
	CGO_ENABLED=1 go build -o $(BUILD_DIR)/$(BINARY_SERVER) ./cmd/server

## build-worker: Build the sandbox worker
build-worker:
	CGO_ENABLED=1 go build -o $(BUILD_DIR)/$(BINARY_WORKER) ./cmd/worker

## build-worker-arm64: Cross-compile worker for Linux ARM64 (Graviton bare-metal)
build-worker-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o $(BUILD_DIR)/$(BINARY_WORKER)-arm64 ./cmd/worker

## build-agent: Build the in-VM agent (static binary for Linux ARM64)
build-agent:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o $(BUILD_DIR)/$(BINARY_AGENT) ./cmd/agent

## build-server-arm64: Cross-compile server for Linux ARM64
build-server-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o $(BUILD_DIR)/$(BINARY_SERVER)-arm64 ./cmd/server

## --- Local Testing (3 tiers) ---

## run-dev: Tier 1 - Combined mode, no auth, no PG/NATS (simplest)
run-dev: build-server
	OPENCOMPUTER_MODE=combined \
	OPENCOMPUTER_API_KEY= \
	OPENCOMPUTER_DATA_DIR=/tmp/opencomputer-data \
	$(BUILD_DIR)/$(BINARY_SERVER)

## run: Tier 1 - Combined mode with static API key
run: build-server
	OPENCOMPUTER_MODE=combined \
	OPENCOMPUTER_API_KEY=test-key \
	OPENCOMPUTER_DATA_DIR=/tmp/opencomputer-data \
	$(BUILD_DIR)/$(BINARY_SERVER)

## run-pg: Tier 2 - Combined mode with PostgreSQL (requires: make infra-up)
run-pg: build-server
	OPENCOMPUTER_MODE=combined \
	OPENCOMPUTER_API_KEY=test-key \
	OPENCOMPUTER_JWT_SECRET=dev-secret-change-me \
	OPENCOMPUTER_DATABASE_URL="postgres://opencomputer:opencomputer@localhost:5432/opencomputer?sslmode=disable" \
	OPENCOMPUTER_DATA_DIR=/tmp/opencomputer-data \
	OPENCOMPUTER_HTTP_ADDR=http://localhost:8080 \
	$(BUILD_DIR)/$(BINARY_SERVER)

## run-pg-workos: Tier 2 - Combined with PG + WorkOS + Vite dev (requires: make infra-up)
##   Redirect URI goes through Vite proxy so cookies are set on :3000.
##   Add http://localhost:3000/auth/callback as redirect URI in your WorkOS dashboard.
run-pg-workos: build-server
	OPENCOMPUTER_MODE=combined \
	OPENCOMPUTER_API_KEY=test-key \
	OPENCOMPUTER_JWT_SECRET=dev-secret-change-me \
	OPENCOMPUTER_DATABASE_URL="postgres://opencomputer:opencomputer@localhost:5432/opencomputer?sslmode=disable" \
	OPENCOMPUTER_DATA_DIR=/tmp/opencomputer-data \
	OPENCOMPUTER_HTTP_ADDR=http://localhost:8080 \
	WORKOS_API_KEY=$${WORKOS_API_KEY} \
	WORKOS_CLIENT_ID=$${WORKOS_CLIENT_ID} \
	WORKOS_REDIRECT_URI=http://localhost:3000/auth/callback \
	WORKOS_FRONTEND_URL=$${WORKOS_FRONTEND_URL} \
	$(BUILD_DIR)/$(BINARY_SERVER)

## run-pg-workos-prod: Tier 2 - Combined with PG + WorkOS + built dashboard (requires: make infra-up web-build)
run-pg-workos-prod: build-server
	OPENCOMPUTER_MODE=combined \
	OPENCOMPUTER_API_KEY=test-key \
	OPENCOMPUTER_JWT_SECRET=dev-secret-change-me \
	OPENCOMPUTER_DATABASE_URL="postgres://opencomputer:opencomputer@localhost:5432/opencomputer?sslmode=disable" \
	OPENCOMPUTER_DATA_DIR=/tmp/opencomputer-data \
	OPENCOMPUTER_HTTP_ADDR=http://localhost:8080 \
	WORKOS_API_KEY=$${WORKOS_API_KEY} \
	WORKOS_CLIENT_ID=$${WORKOS_CLIENT_ID} \
	WORKOS_REDIRECT_URI=http://localhost:8080/auth/callback \
	$(BUILD_DIR)/$(BINARY_SERVER)

## run-full-server: Tier 3 - Control plane only (requires: make infra-up)
run-full-server: build-server
	OPENCOMPUTER_MODE=server \
	OPENCOMPUTER_PORT=8080 \
	OPENCOMPUTER_API_KEY=test-key \
	OPENCOMPUTER_JWT_SECRET=dev-secret-change-me \
	OPENCOMPUTER_DATABASE_URL="postgres://opencomputer:opencomputer@localhost:5432/opencomputer?sslmode=disable" \
	OPENCOMPUTER_NATS_URL=nats://localhost:4222 \
	OPENCOMPUTER_REGION=local \
	OPENCOMPUTER_WORKER_ID=cp-local-1 \
	OPENCOMPUTER_HTTP_ADDR=http://localhost:8080 \
	OPENCOMPUTER_DATA_DIR=/tmp/opencomputer-data \
	$(BUILD_DIR)/$(BINARY_SERVER)

## run-full-worker: Tier 3 - Worker only (requires: make infra-up)
run-full-worker: build-worker
	OPENCOMPUTER_MODE=worker \
	OPENCOMPUTER_PORT=8081 \
	OPENCOMPUTER_JWT_SECRET=dev-secret-change-me \
	OPENCOMPUTER_NATS_URL=nats://localhost:4222 \
	OPENCOMPUTER_REGION=local \
	OPENCOMPUTER_WORKER_ID=w-local-1 \
	OPENCOMPUTER_HTTP_ADDR=http://localhost:8081 \
	OPENCOMPUTER_DATA_DIR=/tmp/opencomputer-worker-data \
	OPENCOMPUTER_MAX_CAPACITY=50 \
	$(BUILD_DIR)/$(BINARY_WORKER)

## --- Infrastructure ---

## infra-up: Start PostgreSQL + NATS via Docker Compose
infra-up:
	docker compose -f deploy/docker-compose.yml up -d
	@echo "Waiting for PostgreSQL..."
	@until docker compose -f deploy/docker-compose.yml exec -T postgres pg_isready -U opencomputer 2>/dev/null; do sleep 1; done
	@echo "Infrastructure ready: PostgreSQL :5432, NATS :4222"

## infra-down: Stop infrastructure
infra-down:
	docker compose -f deploy/docker-compose.yml down

## infra-reset: Stop infrastructure and delete volumes
infra-reset:
	docker compose -f deploy/docker-compose.yml down -v

## seed: Create a test org and API key in PostgreSQL (requires: make infra-up)
seed:
	@docker compose -f deploy/docker-compose.yml exec -T postgres psql -U opencomputer -d opencomputer -c " \
		INSERT INTO orgs (name, slug) VALUES ('Test Org', 'test-org') ON CONFLICT (slug) DO NOTHING; \
		INSERT INTO api_keys (org_id, key_hash, key_prefix, name) \
		SELECT id, encode(sha256('test-key'::bytea), 'hex'), 'test-key', 'Dev Key' \
		FROM orgs WHERE slug = 'test-org' \
		ON CONFLICT (key_hash) DO NOTHING; \
	" 2>/dev/null && echo "Seeded: org=test-org, api_key=test-key" || echo "Seed failed (run migrations first by starting the server)"

## --- Web Dashboard ---

## web-dev: Start Vite dev server for dashboard (proxies to Go on :8080)
web-dev:
	cd web && npm run dev

## web-build: Build dashboard for production
web-build:
	cd web && npm install && npm run build

## build-all: Build Go binaries + web dashboard
build-all: build web-build

## --- Standard ---

## test: Run all tests
test:
	go test ./... -v -count=1

## test-unit: Run unit tests only (skip integration)
test-unit:
	go test ./... -v -count=1 -short

## test-hibernation: Run hibernation integration test (requires: server running with S3)
test-hibernation:
	@./scripts/test-hibernation.sh

## fmt: Format code
fmt:
	go fmt ./...
	goimports -w . 2>/dev/null || true

## lint: Run linter
lint:
	golangci-lint run ./... 2>/dev/null || go vet ./...

## tidy: Tidy go modules
tidy:
	go mod tidy

## clean: Remove build artifacts
clean:
	rm -rf $(BUILD_DIR)
	rm -rf /tmp/opencomputer-data /tmp/opencomputer-worker-data

## proto: Regenerate protobuf/gRPC code
proto:
	protoc --go_out=. --go_opt=paths=source_relative \
		--go-grpc_out=. --go-grpc_opt=paths=source_relative \
		proto/worker/worker.proto
	protoc --go_out=. --go_opt=paths=source_relative \
		--go-grpc_out=. --go-grpc_opt=paths=source_relative \
		proto/agent/agent.proto

## --- Firecracker ---

## build-rootfs: Build base ext4 rootfs images for Firecracker VMs (requires root)
build-rootfs:
	sudo AGENT_BIN=$(BUILD_DIR)/$(BINARY_AGENT) IMAGES_DIR=$(BUILD_DIR)/images ./scripts/build-rootfs.sh all

## download-kernel: Download the Firecracker-compatible ARM64 kernel
download-kernel:
	./scripts/download-kernel.sh $(BUILD_DIR)/vmlinux-arm64

## deploy-worker: Deploy worker + agent to EC2 instance (set WORKER_IP=<ip>)
deploy-worker:
	./deploy/ec2/deploy-worker.sh

## --- Docker ---

## docker-server: Build server Docker image
docker-server:
	docker build -f deploy/Dockerfile.server -t opencomputer-server .

## docker-worker: Build worker Docker image
docker-worker:
	docker build -f deploy/Dockerfile.worker -t opencomputer-worker .

## docker: Build all Docker images
docker: docker-server docker-worker
