/* SanaaPro — espace boutique : service worker
   Nom de cache PRÉFIXÉ PAR L'APP : toutes les boutiques SanaaPro partagent
   le domaine sanaapro.github.io, donc un nom générique effacerait le cache
   des autres applications du même domaine. Ne jamais retirer ce préfixe. */
const CACHE = "sanaapro-tape-espace-v3";
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

  /* Pages HTML : la copie du téléphone s'ouvre TOUT DE SUITE (l'app pèse
     plus de 200 Ko : sur un réseau lent, la retélécharger à chaque ouverture
     prenait parfois une minute). La nouvelle version se télécharge en
     arrière-plan ; quand elle est différente, la page reçoit un message
     « sanaapro-update » et propose de l'ouvrir. Sans copie sur le téléphone
     (première ouverture), on passe par le réseau comme avant. */
  const isPage = req.mode === "navigate" || /\.html$/.test(url.pathname) || url.pathname.endsWith("/");
  if (url.origin === self.location.origin && isPage) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      let hit = await cache.match(req, { ignoreSearch: true });
      if (!hit && url.pathname.endsWith("/")) hit = await cache.match(new URL("index.html", url).href);
      const net = fetch(req, { cache: "no-cache" }).then(async (res) => {
        if (res && res.ok) {
          const fresh = res.clone();
          let changed = !hit;
          if (hit) {
            const a = hit.headers.get("etag") || hit.headers.get("last-modified");
            const b = res.headers.get("etag") || res.headers.get("last-modified");
            if (a && b) changed = a !== b;
            else { try { changed = (await hit.clone().text()) !== (await res.clone().text()); } catch (_) { changed = false; } }
          }
          await cache.put(req, fresh).catch(() => {});
          if (hit && changed) {
            let list = [];
            const id = e.resultingClientId || e.clientId;
            const one = id ? await self.clients.get(id) : null;
            if (one) list = [one];
            else list = (await self.clients.matchAll({ type: "window" })).filter((c) => new URL(c.url).pathname === url.pathname);
            list.forEach((c) => c.postMessage({ type: "sanaapro-update" }));
          }
        }
        return res;
      });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      try { return await net; } catch (_) { return Response.error(); }
    })());
    return;
  }

  /* Autres fichiers de l'app (icônes, scripts) : cache d'abord, rafraîchi
     en arrière-plan. */
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
