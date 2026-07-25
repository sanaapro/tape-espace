/* SanaaPro — espace boutique : service worker
   Nom de cache PRÉFIXÉ PAR L'APP : toutes les boutiques SanaaPro partagent
   le domaine sanaapro.github.io, donc un nom générique effacerait le cache
   des autres applications du même domaine. Ne jamais retirer ce préfixe. */
const CACHE = "sanaapro-tape-espace-v1";
const PREFIX = "sanaapro-tape-espace-";

const CORE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.indexOf(PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Toujours au réseau : les API vivantes (Firestore, authentification).
   Les mettre en cache renverrait des données périmées ou casserait la session. */
function liveApi(url) {
  const h = url.hostname;
  return h === "firestore.googleapis.com"
      || h === "identitytoolkit.googleapis.com"
      || h === "securetoken.googleapis.com"
      || h === "firebaseinstallations.googleapis.com";
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (liveApi(url)) return;

  /* SDK Firebase sur gstatic : cache d'abord. C'est le plus gros du
     téléchargement, et il ne change jamais pour une version donnée. */
  if (url.hostname === "www.gstatic.com") {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  /* Fichiers de l'app : on répond depuis le cache tout de suite, et on
     rafraîchit en arrière-plan. Une nouvelle version téléversée apparaît
     donc à l'ouverture suivante, sans jamais bloquer sur le réseau. */
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
