/* Service Worker — 讓 ETF 試算可離線使用。
   策略：預快取核心檔案；HTML/JS 用「網路優先、離線退回快取」，
   確保每次連線都拿到最新版，斷線時仍能開啟。
   改版時把 CACHE 版本號 +1，即可讓舊快取自動汰換。
   注意：行情資料走 proxy 即時抓取，不在此快取，離線時工具會自動用上次資料。 */
const CACHE = "etf-v1";
const CORE = [
  "./",
  "./index.html",
  "./engine.js",
  "./manifest.json",
  "../../assets/icon-192.png",
  "../../assets/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 行情 proxy 一律走網路（不快取），讓資料即時更新
  if (url.hostname.indexOf("workers.dev") !== -1 && url.pathname === "/") return;
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith(
      fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => cached))
  );
});
