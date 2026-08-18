import importlib.util
from pathlib import Path
from datetime import timezone

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
