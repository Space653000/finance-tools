@echo off
setlocal
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
echo ================================================================
echo   Leverage Compound Simulator - Independent Verification
echo ================================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found.
  echo     Install LTS from: https://nodejs.org
  echo.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [X] Python not found.
  echo     Install from: https://www.python.org/downloads
  echo     IMPORTANT: check "Add python.exe to PATH" during install.
  echo.
  pause
  exit /b 1
)

echo [1/4] Extract engine from index.html and run fixed cases...
node harness.js
if errorlevel 1 goto :fail
echo.
echo [2/4] Run independent Python implementation...
python independent.py
if errorlevel 1 goto :fail
echo.
echo [3/4] Large-scale sweep, 11000+ cases, 1-3 minutes...
node sweep.js
if errorlevel 1 goto :fail
python sweep_check.py > sweep_report.txt 2>&1
type sweep_report.txt
echo.
echo [4/4] Three-way comparison...
python compare.py > report.txt 2>&1
type report.txt
echo.
echo ================================================================
echo   Done. Please send back: report.txt and sweep_report.txt
echo   Also open verification_workbook.xlsx and check the
echo   verdict column in all 5 sheets.
echo ================================================================
pause
exit /b 0

:fail
echo.
echo [X] Failed. Please copy the messages above and send them back.
pause
exit /b 1
