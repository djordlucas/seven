.PHONY: install test ci serve clean

install:
	pip install -e ".[dev]"

test:
	python -m pytest tests/ -q

ci: test

serve:
	seven serve --host 127.0.0.1 --port 8000

clean:
	rm -rf .venv .pytest_cache build dist *.egg-info
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
