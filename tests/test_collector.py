import asyncio
import importlib.util
from pathlib import Path
from datetime import timezone

import pytest

MODULE_PATH = Path(__file__).parents[1] / "collector" / "dzen_collect.py"
spec = importlib.util.spec_from_file_location("dzen_collect", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


def test_normalize_channel_url_and_slug():
    assert mod.normalize_channel("https://dzen.ru/worldlord?share_to=link") == "worldlord"
    assert mod.normalize_channel("worldlord") == "worldlord"
    assert mod.normalize_channel("https://dzen.ru/id/abcdef") == "id/abcdef"


def test_object_id_timestamp():
    dt = mod.oid_to_datetime("65920080abcdefabcdefabcd")
    assert dt.tzinfo == timezone.utc
    assert dt.isoformat().startswith("2024-01-01T00:00:00")


def test_collect_cards_recursive():
    payload = {
        "items": [
            {"x": {"type": "card", "publication_object_id": "65920080abcdefabcdefabcd", "title": "A", "views": 10}},
            {"type": "video", "publication_object_id": "65920080abcdefabcdefabce", "title": "B", "views": 20},
        ]
    }
    out = []
    mod.collect_cards(payload, out)
    assert len(out) == 1
    assert out[0]["title"] == "A"


class FakePage:
    def __init__(self, responses):
        self.responses = list(responses)
        self.goto_calls = []
        self.waits = []

    async def evaluate(self, _script, _url):
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    async def wait_for_timeout(self, ms):
        self.waits.append(ms)

    async def goto(self, url, **_kwargs):
        self.goto_calls.append(url)


def test_non_json_recovery_reopens_channel_once():
    page = FakePage([
        {"status": 200, "text": "<html>captcha</html>"},
        {"status": 200, "text": '{"ok": true}'},
    ])
    result = asyncio.run(
        mod.page_json_fetch(
            page,
            "https://dzen.ru/api/test",
            recovery_url="https://dzen.ru/worldlord",
            retries=1,
            recovery_pause_ms=10,
        )
    )
    assert result == {"ok": True}
    assert page.goto_calls == ["https://dzen.ru/worldlord"]


def test_403_is_not_bypassed_or_retried():
    page = FakePage([
        {"status": 403, "text": "<html>forbidden</html>"},
    ])
    with pytest.raises(RuntimeError, match="HTTP 403"):
        asyncio.run(
            mod.page_json_fetch(
                page,
                "https://dzen.ru/api/test",
                recovery_url="https://dzen.ru/worldlord",
                retries=1,
            )
        )
    assert page.goto_calls == []
