FROM python:3.15-slim

WORKDIR /app
COPY pyproject.toml README.md ./
COPY seven ./seven
# Editable so a bind-mounted ./seven in compose.dev.yaml is the live code
# (hot-reload); see compose.dev.yaml.
RUN pip install --no-cache-dir -e .

RUN useradd --create-home --uid 1000 seven
USER seven
WORKDIR /workspace
ENV SEVEN_WORKSPACE=/workspace
EXPOSE 8000
CMD ["seven", "serve", "--host", "0.0.0.0", "--port", "8000"]
