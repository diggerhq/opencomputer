.PHONY: build run test fmt lint clean help

# Build variables
BINARY_SERVER = opensandbox-server
BINARY_WORKER = opensandbox-worker
BUILD_DIR = bin

## help: Show this help message
help:
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/## //' | column -t -s ':'

## build: Build server and worker binaries
build: build-server build-worker

## build-server: Build the control plane server
build-server:
	go build -o $(BUILD_DIR)/$(BINARY_SERVER) ./cmd/server

## build-worker: Build the sandbox worker
build-worker:
	go build -o $(BUILD_DIR)/$(BINARY_WORKER) ./cmd/worker

## run: Run the server in combined mode
run: build-server
	OPENSANDBOX_MODE=combined $(BUILD_DIR)/$(BINARY_SERVER)

## run-dev: Run the server with no auth for development
run-dev: build-server
	OPENSANDBOX_MODE=combined OPENSANDBOX_API_KEY= $(BUILD_DIR)/$(BINARY_SERVER)

## test: Run all tests
test:
	go test ./... -v -count=1

## test-unit: Run unit tests only (skip integration)
test-unit:
	go test ./... -v -count=1 -short

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

## docker-server: Build server Docker image
docker-server:
	docker build -f deploy/Dockerfile.server -t opensandbox-server .

## docker-worker: Build worker Docker image
docker-worker:
	docker build -f deploy/Dockerfile.worker -t opensandbox-worker .

## docker: Build all Docker images
docker: docker-server docker-worker
