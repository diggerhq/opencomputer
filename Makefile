.PHONY: help web-dev web-build

## help: Show this help message
help:
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/## //' | column -t -s ':'

## web-dev: Start Vite dev server for the dashboard
web-dev:
	cd web && npm run dev

## web-build: Build dashboard for production
web-build:
	cd web && npm install && npm run build
