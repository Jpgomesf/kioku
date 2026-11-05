# One command surface for people and coding agents. `make check` is the done gate.
CARGO ?= cargo
ENV_FILE ?= .env
SMOKE_ENV ?= .env.smoke

.PHONY: help check fmt fmt-check lint test test-db smoke eval build install start stop stop-docker-ollama doctor deny

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

check: fmt-check lint test ## Formatting, lints (warnings denied), unit tests

fmt: ## Format the code
	$(CARGO) fmt

fmt-check:
	$(CARGO) fmt --check

lint: ## Clippy on all targets, with and without the HTTP transport, warnings denied
	CARGO_BUILD_WARNINGS=deny $(CARGO) clippy --all-targets --locked
	CARGO_BUILD_WARNINGS=deny $(CARGO) clippy --all-targets --locked --features http

test: ## Unit tests (no services needed), with and without the HTTP transport
	$(CARGO) test --locked
	$(CARGO) test --locked --features http

test-db: ## PostgreSQL integration tests; MEMORY_TEST_DATABASE_URL must allow CREATE DATABASE
	$(CARGO) test --locked -- --ignored

smoke: ## End-to-end MCP checks over stdio and HTTP; SMOKE_ENV must name test storage
	$(CARGO) build --locked --features http
	python3 tests/mcp_smoke.py --binary "$(CURDIR)/target/debug/kioku" --env-file "$(SMOKE_ENV)"
	python3 tests/http_smoke.py --binary "$(CURDIR)/target/debug/kioku" --env-file "$(SMOKE_ENV)"

eval: ## Retrieval quality on the bundled dataset, in isolated storage
	$(CARGO) run --release --locked -- --env-file "$(ENV_FILE)" eval

build: ## Release build
	$(CARGO) build --release --locked

install: build ## Install the server binary into bin/ (used by scripts/mcp.sh)
	mkdir -p bin
	install -m 755 target/release/kioku bin/kioku

start: ## Start PostgreSQL, Qdrant, and Ollama
	./scripts/start.sh

stop: ## Stop the services; volumes are kept
	./scripts/stop.sh

stop-docker-ollama: ## Stop only the Ollama container, after switching to a native Ollama
	./scripts/stop.sh ollama

doctor: ## Check the services and embeddings
	./bin/kioku --env-file "$(ENV_FILE)" doctor

deny: ## Supply-chain checks (needs cargo-deny)
	cargo deny --locked check
