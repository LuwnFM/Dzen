from pathlib import Path

ROOT = Path(__file__).parents[1]

def test_pages_files_exist():
    html = (ROOT / "site/index.html").read_text(encoding="utf-8")
    js = (ROOT / "site/assets/app.js").read_text(encoding="utf-8")
    assert "downloadPack" in html
    assert "resultsTable" in html
    assert "makeZip" in js
    assert "robustScore" in js
    assert "textAnalysis" in js

def test_template_has_config_slot():
    src = (ROOT / "site/downloads/dzen_collect_template.py").read_text(encoding="utf-8")
    assert '__CONFIG_B64__' in src
