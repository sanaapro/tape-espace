// SanaaPro — lecteur de cahier de mesures
// Reçoit la photo d'une page de cahier depuis l'app SanaaPro (utilisateur connecté),
// la fait lire par Gemini et renvoie les mesures dans les clés de l'app.
// La clé GEMINI_API_KEY reste ici, sur le serveur : elle n'apparaît jamais dans l'app.
import http from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

const PORT = process.env.PORT || 10000;
const KEY = process.env.GEMINI_API_KEY || "";
const PROJECT = process.env.FIREBASE_PROJECT || "sanaapro-app";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://sanaapro.github.io").split(",").map(s => s.trim());
const MODELS = [process.env.GEMINI_MODEL, "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-flash-latest"].filter(Boolean);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 80);
const MAX_BODY = 4 * 1024 * 1024;

const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
async function uidFrom(req){
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if(!tok) return null;
  try{
    const { payload } = await jwtVerify(tok, JWKS, { issuer: "https://securetoken.google.com/" + PROJECT, audience: PROJECT });
    return payload.sub || null;
  }catch(e){ return null; }
}

// limite simple par boutique et par jour (en mémoire)
const usage = new Map();
function allow(uid){
  const day = new Date().toISOString().slice(0, 10), k = uid + ":" + day;
  const n = (usage.get(k) || 0) + 1;
  if(usage.size > 5000) usage.clear();
  usage.set(k, n);
  return n <= DAILY_LIMIT;
}

function cors(req, res){
  const o = req.headers.origin;
  if(o && ORIGINS.includes(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function send(res, code, obj){
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req){
  return new Promise((ok, ko) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if(size > MAX_BODY){ ko(new Error("too_big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", ko);
  });
}

function prompt(champs, genre){
  const liste = champs.map(c => `- "${c[0]}" : ${c[1]}`).join("\n");
  return `Tu lis la photo d'une page de cahier de couturier (Afrique de l'Ouest), écrite à la main.
On y trouve les mesures d'une cliente ou d'un client (${genre === "homme" ? "homme" : "femme"}), en centimètres.
Les couturiers utilisent souvent des abréviations, par exemple : Ep = épaule, P ou Poit = poitrine, T = taille,
B ou Bas = bassin, LM ou L.manche = longueur manche, TM = tour de manche, MC = manche courte, Cou, Poig = poignet,
LR = longueur robe, LJ = longueur jupe, LB = longueur boubou, LP ou L.pant = longueur pantalon, Ceint = ceinture,
Cuis = cuisse, Gen = genou, BP = bas du pantalon, Carr = carrure, LT = longueur de taille, LC = longueur corsage.
Associe chaque mesure lue à UNE des clés suivantes (et seulement celles-ci) :
${liste}
Règles :
- N'invente rien. Si une mesure est illisible ou absente, ne la mets pas.
- Les nombres sont en cm ; garde les demi (ex. 42.5). Ignore les prix et les dates.
- Si la page contient plusieurs personnes, lis seulement la première (en haut) et mets "plusieurs": true.
- Si tu vois le nom ou le téléphone de la personne, renvoie-les.
Réponds UNIQUEMENT en JSON : {"nom":"","telephone":"","plusieurs":false,"mesures":{"cle":nombre}}`;
}

async function lire(b64, mime, champs, genre){
  let lastErr = "no_model";
  for(const model of MODELS){
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt(champs, genre) }, { inline_data: { mime_type: mime, data: b64 } }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" }
      })
    });
    if(r.status === 404 || r.status === 400 && model !== MODELS[MODELS.length - 1]){
      lastErr = "model_" + r.status + ":" + model; console.log("modèle indisponible", model, r.status); continue;
    }
    if(!r.ok){ const t = await r.text(); console.log("gemini", r.status, t.slice(0, 300)); throw new Error("gemini_" + r.status); }
    const j = await r.json();
    const txt = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || "").join("") || "{}";
    let out; try{ out = JSON.parse(txt.replace(/^```json|```$/g, "").trim()); }catch(e){ out = {}; }
    out._model = model;
    return out;
  }
  throw new Error(lastErr);
}

http.createServer(async (req, res) => {
  cors(req, res);
  if(req.method === "OPTIONS"){ res.writeHead(204); return res.end(); }
  const path = (req.url || "/").split("?")[0];
  if(req.method === "GET") return send(res, 200, { ok: true, service: "sanaapro-lecteur-cahier", pret: !!KEY });
  if(req.method !== "POST" || path !== "/lire") return send(res, 404, { error: "not_found" });
  if(!KEY) return send(res, 503, { error: "no_key" });

  const uid = await uidFrom(req);
  if(!uid) return send(res, 401, { error: "auth" });
  if(!allow(uid)) return send(res, 429, { error: "limit" });

  let body;
  try{ body = JSON.parse(await readBody(req)); }catch(e){ return send(res, 413, { error: "body" }); }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ""));
  if(!m) return send(res, 400, { error: "image" });
  const champs = Array.isArray(body.champs) ? body.champs.filter(c => Array.isArray(c) && /^[A-Za-z]{2,30}$/.test(c[0])).slice(0, 60).map(c => [c[0], String(c[1] || c[0]).slice(0, 60)]) : [];
  if(!champs.length) return send(res, 400, { error: "champs" });
  const ok = new Set(champs.map(c => c[0]));

  try{
    const r = await lire(m[2], m[1], champs, body.genre);
    const mesures = {};
    Object.entries(r.mesures || {}).forEach(([k, v]) => {
      const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
      if(ok.has(k) && isFinite(n) && n > 0 && n < 400) mesures[k] = Math.round(n * 2) / 2;
    });
    send(res, 200, {
      mesures,
      nom: String(r.nom || "").slice(0, 80),
      telephone: String(r.telephone || "").replace(/[^0-9+ ]/g, "").slice(0, 20),
      plusieurs: !!r.plusieurs
    });
    console.log("lu", uid.slice(0, 6), Object.keys(mesures).length, "mesures", r._model);
  }catch(e){
    console.log("erreur", e.message);
    send(res, 502, { error: "read" });
  }
}).listen(PORT, () => { console.log("lecteur de cahier prêt sur", PORT, "modèles:", MODELS.join(", ")); selfTest(); });

// Au démarrage : vérifie que la clé fonctionne et quel modèle répond (visible dans les journaux Render)
async function selfTest(){
  if(!KEY){ console.log("AUTOTEST : pas de clé GEMINI_API_KEY"); return; }
  for(const model of MODELS){
    try{
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Réponds seulement OK" }] }] })
      });
      const t = await r.text();
      console.log("AUTOTEST", model, r.status, r.ok ? "CLÉ OK" : t.slice(0, 200).replace(/\s+/g, " "));
      if(r.ok) return;
    }catch(e){ console.log("AUTOTEST", model, "erreur", e.message); }
  }
}
