from app.ai.tokenizer import BaselineTokenizer
from app.core.security import is_local_inference_url_safe, validate_attachment


def test_tokenizer_deterministic() -> None:
    tok = BaselineTokenizer()
    a = tok.inspect("Project Genesis Step 01")
    b = tok.inspect("Project Genesis Step 01")
    assert a["token_count"] > 0
    assert a["tokens"] == b["tokens"]


def test_local_inference_ssrf_guard() -> None:
    ok_local, _ = is_local_inference_url_safe("http://127.0.0.1:8080")
    ok_remote, _ = is_local_inference_url_safe("https://example.com/v1")
    assert ok_local is True
    assert ok_remote is False


def test_attachment_policy() -> None:
    ok, sanitized = validate_attachment("../secret.py", 1024, [".py", ".md"], 5)
    assert ok is True
    assert sanitized == "secret.py"

    blocked, _ = validate_attachment("payload.exe", 1024, [".py", ".md"], 5)
    assert blocked is False
