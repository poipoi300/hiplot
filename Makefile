install:
	bun install
	uv sync

clean:
	rm -rf node_modules .venv

build:
	bun run build

pkg: build
	uv build

test: build
	uv run pytest
	bun test
	bun run test:js

check:
	uv run pre-commit run --all-files

coverage:
	bash tools/stack_coverage_gate.sh

dev:
	uv run --extra server hiplot --port 8765 --host 0.0.0.0

docs: build
	uv run --no-default-groups --group docs sphinx-build -b html docs docs/_build/html
