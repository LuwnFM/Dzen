@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  set PY=py
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python 3 not found. Install Python 3.11+ and run this file again.
    pause
    exit /b 1
  )
  set PY=python
)

if not exist .venv (
  %PY% -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install "playwright>=1.54,<2"
python -m playwright install chromium
python dzen_collect.py
echo.
echo Done. See the results folder.
pause
