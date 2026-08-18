(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  let scoredRows = [];

  const channelsEl = $("#channels");
  const statusEl = $("#collectorStatus");

  function parseChannels() {
    const values = channelsEl.value
      .split(/\r?\n/)
      .map(v => v.trim())
      .filter(Boolean);
    const out = [];
    const errors = [];
    for (const raw of values) {
      let slug = raw;
      try {
        if (/^https?:\/\//i.test(raw)) {
          const u = new URL(raw);
          if (!["dzen.ru", "www.dzen.ru"].includes(u.hostname.toLowerCase())) {
            throw new Error("не dzen.ru");
          }
          slug = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, "");
        } else {
          slug = raw.replace(/^dzen\.ru\//i, "").split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "");
        }
        if (!slug) throw new Error("нет слага");
        if (!out.includes(slug)) out.push(slug);
      } catch (e) {
        errors.push(`${raw}: ${e.message}`);
      }
    }
    return { channels: out, errors };
  }

  function updateCollectorStatus() {
    const { channels, errors } = parseChannels();
    if (!channels.length) {
      statusEl.className = "status muted";
      statusEl.textContent = "Добавь хотя бы один канал.";
      return;
    }
    if (errors.length) {
      statusEl.className = "status bad";
      statusEl.textContent = `Каналов: ${channels.length}. Ошибок строк: ${errors.length}.`;
      return;
    }
    statusEl.className = "status good";
    statusEl.textContent = `Готово к генерации: ${channels.length} канал(ов).`;
  }
  channelsEl.addEventListener("input", updateCollectorStatus);

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  function downloadBlob(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  async function configuredPython() {
    const parsed = parseChannels();
    if (!parsed.channels.length || parsed.errors.length) {
      throw new Error("Исправь список каналов перед скачиванием.");
    }
    const config = {
      channels: parsed.channels,
      days: Math.max(1, Math.min(365, Number($("#days").value) || 60)),
      max_pages: Math.max(1, Math.min(100, Number($("#maxPages").value) || 30)),
      headless: $("#headless").checked,
      delay_ms: 450
    };
    const response = await fetch("./downloads/dzen_collect_template.py", { cache: "no-store" });
    if (!response.ok) throw new Error(`Не удалось загрузить шаблон: HTTP ${response.status}`);
    const template = await response.text();
    const b64 = utf8ToBase64(JSON.stringify(config));
    return template.replace("__CONFIG_B64__", b64);
  }

  $("#downloadPy").addEventListener("click", async () => {
    try {
      const py = await configuredPython();
      downloadBlob("dzen_collect.py", new Blob([py], { type: "text/x-python;charset=utf-8" }));
    } catch (e) {
      alert(e.message);
    }
  });

  const windowsBat = `@echo off\r
setlocal\r
cd /d "%~dp0"\r
where py >nul 2>nul\r
if %errorlevel%==0 (set PY=py) else (set PY=python)\r
%PY% --version >nul 2>nul || (echo Python 3 not found. Install Python 3.11+ and retry.& pause & exit /b 1)\r
if not exist .venv %PY% -m venv .venv\r
call .venv\\Scripts\\activate.bat\r
python -m pip install --upgrade pip\r
python -m pip install "playwright>=1.54,<2"\r
python -m playwright install chromium\r
python dzen_collect.py\r
echo.\r
echo Done. See the results folder.\r
pause\r
`;

  const unixSh = `#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
PY="\${PYTHON:-python3}"
[ -d .venv ] || "$PY" -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install "playwright>=1.54,<2"
python -m playwright install chromium
python dzen_collect.py
echo "Done. See ./results"
`;

  const readme = `DzenDzen local collector

WINDOWS
1. Распакуй ZIP в отдельную папку.
2. Запусти run_windows.bat.
3. Первый запуск поставит Playwright/Chromium в локальное .venv.
4. Результаты будут в results/all_articles.csv и results/report.json.

LINUX / macOS
chmod +x run_linux_macos.sh
./run_linux_macos.sh

Сборщик не логинится, не накручивает метрики и не обходит CAPTCHA/403.
public_counter_raw — сырой публичный счётчик, его смысл надо сверять с текущим UI Дзена.
`;

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
  function u32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
  function concat(parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const name = enc.encode(file.name);
      const data = typeof file.data === "string" ? enc.encode(file.data) : file.data;
      const crc = crc32(data);
      const flags = 0x0800;
      const local = concat([
        u32(0x04034b50), u16(20), u16(flags), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
        name, data
      ]);
      localParts.push(local);

      const central = concat([
        u32(0x02014b50), u16(20), u16(20), u16(flags), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
        u16(0), u16(0), u16(0), u32(0), u32(offset), name
      ]);
      centralParts.push(central);
      offset += local.length;
    }

    const central = concat(centralParts);
    const locals = concat(localParts);
    const end = concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(central.length), u32(locals.length), u16(0)
    ]);
    return new Blob([locals, central, end], { type: "application/zip" });
  }

  $("#downloadPack").addEventListener("click", async () => {
    try {
      const py = await configuredPython();
      const zip = makeZip([
        { name: "dzen_collect.py", data: py },
        { name: "run_windows.bat", data: windowsBat },
        { name: "run_linux_macos.sh", data: unixSh },
        { name: "README.txt", data: readme }
      ]);
      downloadBlob("DzenDzen_local_collector.zip", zip);
    } catch (e) {
      alert(e.message);
    }
  });

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else {
        if (ch === '"') quoted = true;
        else if (ch === ",") { row.push(field); field = ""; }
        else if (ch === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
        else field += ch;
      }
    }
    if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
    if (!rows.length) return [];
    const headers = rows.shift();
    return rows.filter(r => r.some(v => v !== "")).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  }

  function bucket(age) {
    if (age < 3) return "0-3d";
    if (age < 7) return "3-7d";
    if (age < 14) return "7-14d";
    if (age < 30) return "14-30d";
    if (age < 60) return "30-60d";
    if (age < 90) return "60-90d";
    return "90d+";
  }

  function median(vals) {
    if (!vals.length) return 0;
    const a = [...vals].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function robustScore(vals, x) {
    const med = median(vals);
    const mad = median(vals.map(v => Math.abs(v - med)));
    if (mad === 0) return x === med ? 0 : (x > med ? 1 : -1);
    return 0.6745 * (x - med) / mad;
  }

  function scoreRows(rows) {
    const clean = rows
      .filter(r => r.channel && r.title && r.public_counter_raw !== undefined && r.age_days !== undefined)
      .map(r => ({
        ...r,
        public_counter_raw: Math.max(0, Number(r.public_counter_raw) || 0),
        age_days: Math.max(0, Number(r.age_days) || 0)
      }));
    const groups = new Map();
    for (const r of clean) {
      r.age_bucket = bucket(r.age_days);
      r.log_counter = Math.log1p(r.public_counter_raw);
      const key = `${r.channel}\u0000${r.age_bucket}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r.log_counter);
    }
    for (const r of clean) {
      const key = `${r.channel}\u0000${r.age_bucket}`;
      r.performance_score = robustScore(groups.get(key), r.log_counter);
      r.sample_size_in_bucket = groups.get(key).length;
    }
    return clean.sort((a, b) => b.performance_score - a.performance_score);
  }

  function fmt(n) { return new Intl.NumberFormat("ru-RU").format(Math.round(n)); }

  function renderDataset(rows) {
    scoredRows = rows;
    const stats = $("#datasetStats");
    const channels = new Set(rows.map(r => r.channel));
    const counters = rows.map(r => r.public_counter_raw);
    stats.innerHTML = `
      <div class="stat"><b>${rows.length}</b><small>статей</small></div>
      <div class="stat"><b>${channels.size}</b><small>каналов</small></div>
      <div class="stat"><b>${fmt(median(counters))}</b><small>медианный счётчик</small></div>
      <div class="stat"><b>${fmt(Math.max(0, ...counters))}</b><small>максимум</small></div>`;

    const table = $("#resultsTable");
    const tbody = table.querySelector("tbody");
    tbody.textContent = "";
    for (const r of rows.slice(0, 50)) {
      const tr = document.createElement("tr");
      const scoreClass = r.performance_score >= 0 ? "score-pos" : "score-neg";
      tr.innerHTML = `<td class="${scoreClass}">${r.performance_score.toFixed(2)}</td>
        <td>${r.age_bucket}</td><td>${fmt(r.public_counter_raw)}</td>
        <td></td><td></td>`;
      tr.children[3].textContent = r.channel;
      tr.children[4].textContent = r.title;
      tbody.appendChild(tr);
    }
    table.hidden = false;
    $("#downloadScored").disabled = !rows.length;
  }

  $("#csvFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const rows = parseCSV(await file.text());
      renderDataset(scoreRows(rows));
    } catch (err) {
      alert(`Не удалось разобрать CSV: ${err.message}`);
    }
  });

  function csvEscape(v) {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }

  $("#downloadScored").addEventListener("click", () => {
    if (!scoredRows.length) return;
    const headers = ["performance_score","age_bucket","sample_size_in_bucket","channel","public_counter_raw","age_days","published_at_utc","title","article_url"];
    const csv = [headers.join(","), ...scoredRows.map(r => headers.map(h => csvEscape(r[h])).join(","))].join("\r\n");
    downloadBlob("dzen_scored.csv", new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  });

  const WORD_RE = /[A-Za-zА-Яа-яЁё0-9]+(?:-[A-Za-zА-Яа-яЁё0-9]+)?/g;
  const conjunctions = new Set(["и","но","а","или","зато","однако","потом","тогда","поэтому","ведь","хотя","если","когда","пока","причём"]);
  const slop = ["стоит отметить","в современном мире","данный","осуществлять","является","однако","затем"];

  function textAnalysis(text) {
    const sentences = text.match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map(s => s.trim()).filter(Boolean) ?? [];
    const lens = sentences.map(s => (s.match(WORD_RE) || []).length);
    const n = lens.length || 1;
    const short = lens.filter(x => x >= 1 && x <= 6).length;
    const medium = lens.filter(x => x >= 7 && x <= 10).length;
    const long = lens.filter(x => x >= 11).length;
    let conj = 0, maxShort = 0, maxLong = 0, cs = 0, cl = 0;
    for (let i = 0; i < sentences.length; i++) {
      const words = (sentences[i].toLowerCase().match(WORD_RE) || []);
      if (words[0] && conjunctions.has(words[0])) conj++;
      const x = lens[i];
      if (x >= 1 && x <= 6) { cs++; cl = 0; } else if (x >= 11) { cl++; cs = 0; } else { cs = cl = 0; }
      maxShort = Math.max(maxShort, cs); maxLong = Math.max(maxLong, cl);
    }
    const lower = text.toLowerCase();
    const slopHits = slop.filter(p => lower.includes(p));
    const m = {
      chars: text.length, sentences: sentences.length,
      shortRatio: short / n, mediumRatio: medium / n, longRatio: long / n,
      conjunctionRatio: conj / n, emDash: (text.match(/—/g) || []).length,
      enDash: (text.match(/–/g) || []).length, maxShort, maxLong, slopHits
    };
    const warnings = [];
    if (m.emDash > 0) warnings.push(`DG-EM-DASH: длинное тире — ${m.emDash}; эмпирическая цель = 0.`);
    if (m.enDash > 5) warnings.push(`DG-EN-DASH: средних тире ${m.enDash}; эмпирический максимум = 5.`);
    if (m.maxShort >= 3) warnings.push("DG-SHORT-RUN: 3+ коротких предложения подряд.");
    if (m.maxLong >= 2) warnings.push("DG-LONG-RUN: 2+ длинных предложения подряд.");
    if (sentences.length && (m.conjunctionRatio < .20 || m.conjunctionRatio > .30)) warnings.push(`DG-CONJ: начала с союзов ${(m.conjunctionRatio*100).toFixed(1)}%; эмпирическая цель 20–30%.`);
    if (slopHits.length) warnings.push(`DG-AI-SLOP: ${slopHits.join(", ")}.`);
    return { m, warnings };
  }

  $("#analyzeText").addEventListener("click", () => {
    const text = $("#articleText").value.trim();
    if (!text) return;
    const { m, warnings } = textAnalysis(text);
    let lengthClass = "вне стартового prior";
    if (m.chars >= 2800 && m.chars <= 4000) lengthClass = "Compact prior";
    else if (m.chars >= 4200 && m.chars <= 6500) lengthClass = "Standard prior";
    else if (m.chars >= 6500 && m.chars <= 9000) lengthClass = "Long prior";
    $("#styleMetrics").innerHTML = `
      <div class="stat"><b>${fmt(m.chars)}</b><small>знаков</small></div>
      <div class="stat"><b>${m.sentences}</b><small>предложений</small></div>
      <div class="stat"><b>${(m.conjunctionRatio*100).toFixed(1)}%</b><small>с союзом в начале</small></div>
      <div class="stat"><b>${lengthClass}</b><small>длина</small></div>`;
    const box = $("#styleWarnings");
    box.innerHTML = warnings.length
      ? warnings.map(w => `<div class="warning"></div>`).join("")
      : `<div class="ok">Измеримые dzen.guru soft-rules прошли без предупреждений.</div>`;
    [...box.querySelectorAll(".warning")].forEach((el, i) => el.textContent = warnings[i]);
  });

  updateCollectorStatus();
})();
