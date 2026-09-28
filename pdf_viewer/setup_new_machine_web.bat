@echo off
setlocal ENABLEDELAYEDEXPANSION

cd /d "%~dp0"
echo ============================================================
echo   PDF Viewer Web Init (Node + OCR + MinerU)
echo ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js LTS first.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Reinstall Node.js LTS.
  exit /b 1
)

echo [OK] Node/npm found.
node -v
npm -v

set "PY_CMD="
py -3.11 -c "import sys; print(sys.version)" >nul 2>nul
if not errorlevel 1 (
  set "PY_CMD=py -3.11"
) else (
  python -c "import sys; print(sys.version)" >nul 2>nul
  if not errorlevel 1 (
    set "PY_CMD=python"
  )
)

if "%PY_CMD%"=="" (
  echo [ERROR] Python 3.11 not found.
  echo Install Python 3.11, then rerun this script.
  exit /b 1
)

echo [OK] Python command: %PY_CMD%

echo.
echo [1/4] Install web dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  exit /b 1
)

echo.
echo [2/4] Setup OCR venv...
if not exist "ocr_server\.venv311\Scripts\python.exe" (
  %PY_CMD% -m venv "ocr_server\.venv311"
)

call "ocr_server\.venv311\Scripts\python.exe" -m pip install -U pip
call "ocr_server\.venv311\Scripts\python.exe" -m pip install -r "ocr_server\python\requirements.txt"
if errorlevel 1 (
  echo [WARN] OCR dependency install failed with default index, retrying with TUNA mirror...
  call "ocr_server\.venv311\Scripts\python.exe" -m pip install -r "ocr_server\python\requirements.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
  if errorlevel 1 (
    echo [ERROR] OCR dependency install failed.
    exit /b 1
  )
)

echo.
echo [3/4] Setup MinerU venv...
if not exist "mineru\.venv311\Scripts\python.exe" (
  %PY_CMD% -m venv "mineru\.venv311"
)

call "mineru\.venv311\Scripts\python.exe" -m pip install -U pip
call "mineru\.venv311\Scripts\python.exe" -m pip install -r "mineru\requirements.txt"
if errorlevel 1 (
  echo [WARN] MinerU dependency install failed with default index, retrying with TUNA mirror...
  call "mineru\.venv311\Scripts\python.exe" -m pip install -r "mineru\requirements.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
  if errorlevel 1 (
    echo [ERROR] MinerU dependency install failed.
    exit /b 1
  )
)

echo.
echo [4/4] Init done.
echo ------------------------------------------------------------
echo Start OCR:
echo   D:\pdf_viewer\pdf_viewer\ocr_server\python\start_ocr_server_venv311.bat
echo Start Web:
echo   cd /d D:\pdf_viewer\pdf_viewer ^&^& npm start
echo Start MinerU:
echo   cd /d D:\pdf_viewer\pdf_viewer\mineru ^&^& .venv311\Scripts\python.exe app.py
echo ------------------------------------------------------------
echo Health checks:
echo   OCR:    http://127.0.0.1:8766/health
echo   MinerU: http://127.0.0.1:8081/health
echo ------------------------------------------------------------

endlocal
