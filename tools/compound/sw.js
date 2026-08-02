/* Service Worker — 讓槓桿複利模擬器可離線使用。
   策略：預快取核心檔案；HTML 用「網路優先、離線退回快取」，
   確保每次連線都拿到最新版，斷線時仍能開啟。
   改版時把 CACHE 版本號 +1，即可讓舊快取自動汰換。 */
const CACHE = "compound-v1";
const CORE = [
  "./",
  "./index.html",
  "./manifest.json",
  "../../assets/icon-192.png",
  "../../assets/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // HTML / 導覽請求：網路優先，離線退回快取
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }
  // 其他靜態資源：快取優先，沒有再抓網路並補進快取
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached)
    )
  );
});
