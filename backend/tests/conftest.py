import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.update(
    DATABASE_URL="sqlite://",
    STORAGE_DIR="test-storage",
    AI_BASE_URL="http://127.0.0.1:8000",
    AI_MODE="http",
    FRONTEND_ORIGIN="http://localhost:5173",
)


@pytest.fixture(scope="session")
def ai_url(tmp_path_factory):
    default = BACKEND.parent.parent / "hack-bdffe61d-exit-1-ai" / "ai-service"
    service = Path(os.environ.get("AI_SERVICE_DIR", str(default))).resolve()
    if not (service / "app" / "main.py").is_file():
        pytest.skip("Set AI_SERVICE_DIR to the supplied ai-service directory for live HTTP tests")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    env = dict(os.environ, AI_MODE="mock", INTERNAL_TOKEN="integration-test-token", PYTHONPATH=str(service))
    log_path = tmp_path_factory.mktemp("ai") / "server.log"
    with log_path.open("w+") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=service, env=env, stdout=log, stderr=log,
        )
        try:
            with httpx.Client(timeout=1, trust_env=False) as client:
                for _ in range(100):
                    if process.poll() is not None:
                        pytest.fail(log_path.read_text())
                    try:
                        if client.get(url + "/health").status_code == 200:
                            break
                    except httpx.RequestError:
                        pass
                    time.sleep(0.1)
                else:
                    pytest.fail("AI service did not start: " + log_path.read_text())
            yield url
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
