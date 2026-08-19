#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import base64
import csv
import json
import re
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, unquote

CONFIG_B64 = "__CONFIG_B64__"

EXPORT_URL = "https://dzen.ru/api/v3/launcher/export"


@dataclass
class Article:
    channel: str
    publication_object_id: str
    title: str
    public_counter_raw: int
    published_at_utc: str
    collected_at_utc: str
    age_days: float
    article_url: str = ""


def load_embedded_config() -> dict[str, Any]:
    if CONFIG_B64 == "__CONFIG_B64__":
        return {
            "channels": [],
            "days": 60,
            "headless": False,
            "max_pages": 30,
            "delay_ms": 450,
        }
    raw = base64.b64decode(CONFIG_B64.encode("ascii"))
    return json.loads(raw.decode("utf-8"))


def normalize_channel(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("Пустая ссылка/слаг")

    if value.startswith(("http://", "https://")):
        parsed = urlparse(value)
        host = parsed.netloc.casefold().split(":")[0]
        if host not in {"dzen.ru", "www.dzen.ru"}:
            raise ValueError(f"Не ссылка Дзена: {value}")
        path = unquote(parsed.path).strip("/")
        if not path:
            raise ValueError(f"В ссылке нет слага канала: {value}")
        return path

    value = value.split("?", 1)[0].split("#", 1)[0].strip("/")
    if value.startswith("dzen.ru/"):
        value = value[len("dzen.ru/") :]
    if not value:
        raise ValueError("Не удалось определить канал")
    return value


def safe_filename(slug: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", slug.strip("/"))
    return cleaned[:100] or "channel"


def oid_to_datetime(oid: str) -> datetime:
    if len(oid) < 8:
        raise ValueError(f"ObjectId слишком короткий: {oid!r}")
    try:
        unix_seconds = int(oid[:8], 16)
    except ValueError as exc:
        raise ValueError(f"ObjectId не начинается с hex timestamp: {oid!r}") from exc
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc)


def collect_cards(node: Any, out: list[dict[str, Any]], depth: int = 0) -> None:
    if depth > 10 or node is None:
        return
    if isinstance(node, list):
        for item in node:
            collect_cards(item, out, depth + 1)
        return
    if not isinstance(node, dict):
        return

    if (
        node.get("type") == "card"
        and node.get("publication_object_id")
        and node.get("title")
        and isinstance(node.get("views"), (int, float))
    ):
        out.append(node)

    for value in node.values():
        if isinstance(value, (dict, list)):
            collect_cards(value, out, depth + 1)


async def page_json_fetch(
    page,
    url: str,
    *,
    recovery_url: str | None = None,
    retries: int = 1,
    recovery_pause_ms: int = 1200,
) -> dict[str, Any]:
    """Fetch JSON from Dzen page context with the source RUNBOOK recovery.

    The original notes recommend a pause + navigation back to the channel when
    the page loses dzen.ru origin (about:blank / Failed to fetch) or the endpoint
    returns HTML instead of JSON (captcha/redirect). This is a bounded retry, not
    a CAPTCHA solver or HTTP-status bypass.
    """
    last_error: Exception | None = None

    for attempt in range(retries + 1):
        try:
            result = await page.evaluate(
                """async (url) => {
                    const r = await fetch(url, {
                        credentials: 'include',
                        headers: {accept: 'application/json'}
                    });
                    const text = await r.text();
                    return {
                        status: r.status,
                        finalUrl: r.url,
                        contentType: r.headers.get('content-type') || '',
                        text
                    };
                }""",
                url,
            )
        except Exception as exc:
            last_error = RuntimeError(f"fetch failed: {exc}")
        else:
            text = result["text"]
            status = int(result["status"])

            # В исходном RUNBOOK не было обхода 403: HTTP-ошибки не маскируем.
            if status != 200:
                raise RuntimeError(f"HTTP {status} при запросе {url}")

            if text.lstrip().startswith("{"):
                try:
                    return json.loads(text)
                except json.JSONDecodeError as exc:
                    raise RuntimeError("Дзен вернул некорректный JSON") from exc

            last_error = RuntimeError(
                f"non-JSON (captcha/redirect), status {status}"
            )

        if attempt >= retries or not recovery_url:
            break

        print(
            "  WARN: потерян origin или получен non-JSON; "
            "пауза, повторная навигация на канал и один повтор запроса...",
            file=sys.stderr,
        )
        await page.wait_for_timeout(recovery_pause_ms)
        await page.goto(recovery_url, wait_until="domcontentloaded", timeout=45_000)
        await page.wait_for_timeout(max(400, recovery_pause_ms // 2))

    if last_error is not None:
        raise last_error
    raise RuntimeError("Не удалось получить JSON Дзена")


def card_url(card: dict[str, Any]) -> str:
    for key in ("link", "url", "publication_url"):
        value = card.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


async def collect_channel(page, slug: str, *, days: int, max_pages: int, delay_ms: int) -> list[Article]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    collected_at = datetime.now(timezone.utc)
    by_oid: dict[str, Article] = {}

    channel_url = f"https://dzen.ru/{slug}"
    await page.goto(channel_url, wait_until="domcontentloaded", timeout=45_000)
    await page.wait_for_timeout(900)

    export_url = (
        f"{EXPORT_URL}?country_code=ru&lang=ru&clid=300"
        f"&referrer_place=more&channel_name={slug}"
    )
    exp = await page_json_fetch(page, export_url, recovery_url=channel_url)
    article_tab = next(
        (tab for tab in (exp.get("tabs") or []) if tab.get("id") == "article"),
        None,
    )
    if not article_tab or not article_tab.get("url"):
        raise RuntimeError("В export JSON не найдена вкладка article")

    link = article_tab["url"]
    for _ in range(max_pages):
        if not link:
            break

        payload = await page_json_fetch(page, link, recovery_url=channel_url)
        cards: list[dict[str, Any]] = []
        collect_cards(payload.get("items"), cards)
        if not cards:
            break

        newest_on_page: datetime | None = None
        any_recent = False
        for card in cards:
            oid = str(card["publication_object_id"])
            try:
                published = oid_to_datetime(oid)
            except ValueError:
                continue

            if newest_on_page is None or published > newest_on_page:
                newest_on_page = published

            if published < cutoff:
                continue
            any_recent = True

            if oid in by_oid:
                continue

            age_days = max(0.0, (collected_at - published).total_seconds() / 86400.0)
            by_oid[oid] = Article(
                channel=slug,
                publication_object_id=oid,
                title=str(card["title"]).strip(),
                public_counter_raw=int(card["views"]),
                published_at_utc=published.isoformat(),
                collected_at_utc=collected_at.isoformat(),
                age_days=round(age_days, 4),
                article_url=card_url(card),
            )

        if newest_on_page is not None and newest_on_page < cutoff:
            break

        more = payload.get("more")
        link = more.get("link") if isinstance(more, dict) else more
        if not link:
            break

        # Если текущая страница целиком старая, прекращаем пагинацию.
        if not any_recent and newest_on_page is not None and newest_on_page < cutoff:
            break

        await page.wait_for_timeout(delay_ms)

    return sorted(by_oid.values(), key=lambda x: x.published_at_utc, reverse=True)


def write_csv(rows: list[Article], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = list(Article.__dataclass_fields__.keys())
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


async def run(config: dict[str, Any], out_dir: Path) -> int:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print(
            "Не найден Playwright.\n"
            "Запусти через run_windows.bat / run_linux_macos.sh из комплекта\n"
            "или установи вручную:\n"
            "  pip install playwright\n"
            "  python -m playwright install chromium",
            file=sys.stderr,
        )
        return 2

    raw_channels = config.get("channels") or []
    slugs: list[str] = []
    errors: list[dict[str, str]] = []

    for value in raw_channels:
        try:
            slug = normalize_channel(str(value))
            if slug not in slugs:
                slugs.append(slug)
        except ValueError as exc:
            errors.append({"input": str(value), "error": str(exc)})

    if not slugs:
        print("Нет корректных каналов для сбора.", file=sys.stderr)
        return 2

    days = max(1, int(config.get("days", 60)))
    max_pages = max(1, min(100, int(config.get("max_pages", 30))))
    delay_ms = max(250, int(config.get("delay_ms", 450)))
    headless = bool(config.get("headless", False))

    out_dir.mkdir(parents=True, exist_ok=True)
    all_rows: list[Article] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)
        page = await browser.new_page()
        try:
            for index, slug in enumerate(slugs, start=1):
                print(f"[{index}/{len(slugs)}] {slug}")
                try:
                    rows = await collect_channel(
                        page,
                        slug,
                        days=days,
                        max_pages=max_pages,
                        delay_ms=delay_ms,
                    )
                    write_csv(rows, out_dir / f"{safe_filename(slug)}.csv")
                    all_rows.extend(rows)
                    print(f"  OK: {len(rows)} статей")
                except Exception as exc:
                    errors.append({"channel": slug, "error": f"{type(exc).__name__}: {exc}"})
                    print(f"  ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
                await page.wait_for_timeout(max(700, delay_ms))
        finally:
            await browser.close()

    write_csv(all_rows, out_dir / "all_articles.csv")
    report = {
        "collected_at_utc": datetime.now(timezone.utc).isoformat(),
        "channels_requested": slugs,
        "days": days,
        "articles_total": len(all_rows),
        "errors": errors,
        "note": (
            "public_counter_raw — намеренно нейтральное имя. "
            "Не считать его CTR/дочитываниями/доходом без отдельной сверки с текущим UI Дзена."
        ),
    }
    (out_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nГотово. Общий CSV: {out_dir / 'all_articles.csv'}")
    print(f"Отчёт: {out_dir / 'report.json'}")
    return 0 if all_rows else 1


def main() -> None:
    embedded = load_embedded_config()

    ap = argparse.ArgumentParser(description="Локальный сбор публичных метаданных статей Дзен-каналов.")
    ap.add_argument("--days", type=int, default=int(embedded.get("days", 60)))
    ap.add_argument("--out", type=Path, default=Path("results"))
    ap.add_argument("--headless", action="store_true", default=bool(embedded.get("headless", False)))
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--max-pages", type=int, default=int(embedded.get("max_pages", 30)))
    ap.add_argument("channels", nargs="*", help="Ссылки/слаги; если не указаны, берутся из конфигурации сайта.")
    args = ap.parse_args()

    channels = args.channels or embedded.get("channels") or []
    config = {
        **embedded,
        "channels": channels,
        "days": args.days,
        "headless": False if args.headed else args.headless,
        "max_pages": args.max_pages,
    }
    raise SystemExit(asyncio.run(run(config, args.out)))


if __name__ == "__main__":
    main()
