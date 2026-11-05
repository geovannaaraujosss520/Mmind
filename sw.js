// Service worker — habilita "instalar como app" no Chrome/Edge/Android.
// Nunca cacheia dados da VarejOnline/Supabase (sempre ao vivo).
// HTML: rede primeiro (pega sempre a versão nova do painel), cache só se estiver offline.
// Ícones/manifest: cache primeiro.

const CACHE_NAME = "mastermind-sss-v4";
const ARQUIVOS_CASCO = [
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ARQUIVOS_CASCO)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(nomes.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.hostname.endsWith(".supabase.co")) return;

  const ehPagina = event.request.mode === "navigate" || url.pathname.endsWith(".html");
  if (ehPagina) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copia = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copia));
          return resp;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match("./index.html")))
    );
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
