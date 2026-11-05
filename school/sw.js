/* SanaaPro School : service worker.
   Cache PRÉFIXÉ "sanaapro-school-" : le domaine sanaapro.github.io est partagé
   avec l'app couture (préfixe "sanaapro-tape-espace-"), on ne touche jamais à ses caches. */
const CACHE = "sanaapro-school-v5";
const PREFIX = "sanaapro-school-";
const CORE = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.allSettled(CORE.map((u) => c.add(new Request(u, { cache: "reload" })))))
    .then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.indexOf(PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
function liveApi(u) {
  const h = u.hostname;
  return h === "firestore.googleapis.com" || h === "identitytoolkit.googleapis.com"
      || h === "securetoken.googleapis.com" || h === "firebaseinstallations.googleapis.com";
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (liveApi(url)) return;
  if (url.hostname === "www.gstatic.com") {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
      return r;
    })));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.indexOf("/tape-espace/school/") !== 0) return;
  const isPage = req.mode === "navigate" || /\.html$/.test(url.pathname) || url.pathname.endsWith("/");
  if (isPage) {
    /* Pages : réseau d'abord (toujours la dernière version), cache si coupure ou réseau > 6 s. */
    e.respondWith(new Promise((resolve) => {
      let done = false;
      const fromCache = () => caches.match(req, { ignoreSearch: true });
      const timer = setTimeout(() => { fromCache().then((h) => { if (h && !done) { done = true; resolve(h); } }); }, 6000);
      fetch(req, { cache: "no-cache" }).then((r) => {
        if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
        if (!done) { done = true; clearTimeout(timer); resolve(r); }
      }).catch(() => fromCache().then((h) => { if (!done) { done = true; clearTimeout(timer); resolve(h || Response.error()); } }));
    }));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((r) => { if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
