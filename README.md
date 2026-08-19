# DzenDzen

Статический GitHub Pages-интерфейс + локальный сборщик публичных метаданных Дзен-каналов.

## Что уже есть

- генерация персонального `DzenDzen_local_collector.zip` прямо в браузере;
- вставка нескольких `https://dzen.ru/...` ссылок или слагов;
- локальный Python + Playwright collector;
- восстановление из исходного RUNBOOK при потере origin / `Failed to fetch` / non-JSON: пауза, повторная навигация на канал и один повтор запроса;
- HTML с возможной CAPTCHA/redirect распознаётся как non-JSON и проходит тот же ограниченный recovery;
- HTTP 403 и другие явные HTTP-ограничения не обходятся;
- CSV по каждому каналу + общий `all_articles.csv`;
- анализ CSV прямо на GitHub Pages: age buckets + robust median/MAD score;
- deterministic style checker для части dzen.guru empirical rules;
- отдельные policy-файлы: official baseline, dzen.guru empirical, article length prior;
- CI и GitHub Pages deploy workflow.

## Почему сбор идёт локально

GitHub Pages — статический хостинг. Браузерная страница сама не должна пытаться работать с внутренним API Дзена через CORS. Поэтому сайт генерирует конфигурированный локальный скрипт, а запросы выполняются из обычного локального Chromium в контексте `dzen.ru`.

## Быстрый старт

1. Открыть GitHub Pages.
2. Вставить ссылки на каналы.
3. Нажать **Скачать готовый комплект ZIP**.
4. Распаковать.
5. Windows: запустить `run_windows.bat`.
6. Результаты: `results/all_articles.csv`.
7. Перетащить CSV обратно в раздел **Анализ результата** на сайте.

## Ограничения

`public_counter_raw` — намеренно нейтральное имя. Пока семантика поля `views` внутреннего JSON не сверена с текущим UI Дзена, проект не называет его дочитываниями, CTR или доходом.

Проект не:
- логинится в чужие аккаунты;
- накручивает просмотры/клики;
- решает CAPTCHA автоматически;
- обходит HTTP 403, rate limits или другие явные ограничения;
- сохраняет полный текст чужих статей.

При временном non-JSON / captcha-like HTML или потере origin используется только восстановление, которое прямо было описано в исходном RUNBOOK: подождать, снова открыть страницу канала и повторить запрос один раз.

## Development

```bash
python -m pytest -q
python -m http.server 8000 --directory site
```

## GitHub Pages

Workflow `.github/workflows/pages.yml` публикует `site/` через официальный Pages Actions pipeline.
