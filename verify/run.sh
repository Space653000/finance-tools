#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "================================================================"
echo "  槓桿複利模擬器  獨立驗證"
echo "================================================================"
command -v node   >/dev/null || { echo "[X] 找不到 Node.js，請先安裝 https://nodejs.org"; exit 1; }
command -v python3 >/dev/null || { echo "[X] 找不到 Python 3"; exit 1; }
echo && echo "[1/4] 從網頁擷取引擎並執行測試情境..." && node harness.js
echo && echo "[2/4] 執行獨立 Python 實作..."       && python3 independent.py
echo && echo "[3/4] 大規模掃描（11,000+ 組）..." && node sweep.js && python3 sweep_check.py | tee sweep_report.txt
echo && echo "[4/4] 三方比對..."
python3 compare.py | tee report.txt || true
echo
echo "報告已存成 report.txt，請回傳。另請開啟「verification_workbook.xlsx」確認判定欄。"
