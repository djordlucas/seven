# Everything that matters runs in the container (compose.yaml), so a result does
# not depend on the machine. The *-host targets run the same thing on the host's
# Node for a quicker inner loop.
#
# GitHub Actions is not set up; `make ci` is the gate.

COMPOSE := docker compose
DEV     := $(COMPOSE) run --rm dev

.PHONY: help image image-dev dev run ci test test-net lint fmt typecheck deps-reset \
        ci-host test-host lint-host typecheck-host start-host clean

help:
	@echo "make dev        shell in the dev container (repo at /app)"
	@echo "make run        run seven in the runtime image (interactive)"
	@echo "make ci         typecheck + lint + test in the dev container"
	@echo "make test-net   tests including the npm-bundling test (network)"
	@echo "make image      build the runtime image (seven:latest)"
	@echo "make ci-host    the ci gate on the host's Node (>= 24)"

image:
	$(COMPOSE) build seven

image-dev:
	$(COMPOSE) build dev

dev: image-dev
	$(DEV)

run: image
	$(COMPOSE) run --rm seven

ci: image-dev
	$(DEV) make ci-host

test: image-dev
	$(DEV) npm test

test-net: image-dev
	$(DEV) env SEVEN_NET_TEST=1 npm test

lint: image-dev
	$(DEV) npm run lint

fmt: image-dev
	$(DEV) npm run fmt

typecheck: image-dev
	$(DEV) npm run typecheck

# Re-populate the container's node_modules volume after package.json changes.
deps-reset:
	$(DEV) npm ci

ci-host: typecheck-host lint-host test-host

typecheck-host:
	npm run typecheck

lint-host:
	npm run lint

test-host:
	npm test

start-host:
	npm start

clean:
	$(COMPOSE) down --volumes --remove-orphans
