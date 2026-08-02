# Stephen AI Finance Tools

台灣市場的財務試算工具站。所有計算在瀏覽器本地完成，**不上傳任何財務資料**。

## 工具

| 工具 | 路徑 | 狀態 |
|---|---|---|
| 槓桿複利模擬器 | `/tools/compound/` | ✅ v1.0-baseline |
| ETF 定期定額 | `/tools/etf/` | 規劃中 |
| 房貸試算 | `/tools/mortgage/` | 規劃中 |
| FIRE 試算 | `/tools/fire/` | 規劃中 |
| 資產配置 | `/tools/allocation/` | 規劃中 |
| 退休規劃 | `/tools/retirement/` | 規劃中 |

## 技術

原生 HTML / CSS / JavaScript。無建置步驟、無框架、無 npm 依賴。
每個工具是一個獨立的靜態頁面，可直接用瀏覽器開啟。

## 本機開啟

直接用瀏覽器開啟 `tools/compound/index.html` 即可，不需要任何伺服器。

若要模擬正式環境的路徑：

```bash
python3 -m http.server 8000
# 開啟 http://localhost:8000
```

## 部署

推上 GitHub 後由 Cloudflare Pages 自動部署。詳見 `docs/網頁版部署指南.md`。

## 開發規範

見 `CLAUDE.md`。**`tools/compound/index.html` 為凍結基準版，未經同意不得修改。**

## 免責聲明

本站工具僅依使用者輸入的假設進行數學運算，不提供任何預測、投資建議、標的推薦或方案排名。
投資有風險，槓桿會同時放大獲利與虧損。
