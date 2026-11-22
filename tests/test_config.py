from seven.core.config import load_config


def test_defaults(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    cfg = load_config({})
    assert cfg.workspace == tmp_path.resolve()
    assert cfg.model == "mistral-medium-latest"
    assert cfg.max_steps == 40 and cfg.context_tokens == 128_000
    assert cfg.run_timeout_ms == 60_000 and cfg.run_memory_mb == 1024
    assert cfg.max_agents == 16 and cfg.llm_concurrency == 4
    assert cfg.state_db == tmp_path / ".seven" / "seven.db"
    assert cfg.log_file == tmp_path / ".seven" / "logs" / "seven.log"
    assert cfg.public()["api_key_set"] is False and "api_key" not in cfg.public()


def test_dotenv_loaded_without_overriding_env(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text('# comment\nSEVEN_LLM_API_KEY=from-dotenv\nSEVEN_MAX_STEPS=7\n\nBROKEN LINE\n')
    cfg = load_config({"SEVEN_LLM_API_KEY": "from-env"})
    assert cfg.api_key == "from-env"
    assert cfg.max_steps == 7


def test_dotenv_used_when_env_missing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text('SEVEN_LLM_API_KEY="quoted-key"\nSEVEN_LOG_FILE=off\n')
    cfg = load_config({})
    assert cfg.api_key == "quoted-key"
    assert cfg.log_file is None


def test_overrides(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    cfg = load_config({"SEVEN_WORKSPACE": str(tmp_path / "ws"), "SEVEN_RUN_TIMEOUT_MS": "5000",
                       "SEVEN_LOG_LEVEL": "debug", "SEVEN_CONTEXT_TOKENS": "1000"})
    assert cfg.workspace == (tmp_path / "ws").resolve()
    assert cfg.run_timeout_ms == 5000 and cfg.log_level == "debug" and cfg.context_tokens == 1000


def test_spill_chars_zero_disables_spilling(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert load_config({"SEVEN_SPILL_CHARS": "0"}).spill_chars == 0
    assert load_config({"SEVEN_SPILL_CHARS": "500"}).spill_chars == 500
    assert load_config({"SEVEN_SPILL_CHARS": "-5"}).spill_chars == 2000
