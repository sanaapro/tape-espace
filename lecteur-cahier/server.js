// SanaaPro — lecteur de cahier de mesures
// Reçoit la photo d'une page de cahier depuis l'app SanaaPro (utilisateur connecté),
// la fait lire par Gemini et renvoie les mesures dans les clés de l'app.
// La clé GEMINI_API_KEY reste ici, sur le serveur : elle n'apparaît jamais dans l'app.
import http from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const PORT = process.env.PORT || 10000;
const KEY = process.env.GEMINI_API_KEY || "";
const PROJECT = process.env.FIREBASE_PROJECT || "sanaapro-app";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://sanaapro.github.io").split(",").map(s => s.trim());
const MODELS = [process.env.GEMINI_MODEL, "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-flash-latest"].filter(Boolean);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 80);
const MAX_BODY = 6 * 1024 * 1024;

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

async function lire(b64, mime, champs, genre){ return gemini(b64, mime, prompt(champs, genre)); }

async function gemini(b64, mime, texte, opts){
  let lastErr = "no_model";
  const list = (opts && opts.models) || MODELS;
  for(const model of list){
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const gen = { temperature: 0, responseMimeType: "application/json" };
    // Pour la voix on demande une réflexion courte : la réponse arrive plus vite.
    // Si le modèle ne connaît pas ce réglage (400), on réessaie le même modèle sans lui.
    const tries = opts && opts.rapide ? [{ ...gen, thinkingConfig: { thinkingLevel: "low" } }, gen] : [gen];
    let r = null;
    for(const g of tries){
      r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: texte }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: g })
      });
      if(r.status !== 400 || g === tries[tries.length - 1]) break;
      console.log("réglage refusé par", model, "— nouvel essai sans");
    }
    // modèle absent, saturé (503) ou quota épuisé (429) : on passe au modèle suivant
    if((r.status === 404 || r.status === 400 || r.status === 429 || r.status === 503) && model !== list[list.length - 1]){
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

// ---------- Son : l'app envoie une note vocale compressée (Opus/WebM, ou AAC sur iPhone) ----------
// Gemini lit le WAV, le MP3, l'AAC, l'OGG et le FLAC, pas le WebM : on change seulement
// l'emballage (sans réencoder, quelques millisecondes), Ogg pour l'Opus, ADTS pour l'AAC.
const AUDIO_RE = /^data:(audio\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/;
function ffmpeg(input, args){
  return new Promise((ok, ko) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...args, "pipe:1"]);
    const out = [], err = [];
    p.stdout.on("data", c => out.push(c)); p.stderr.on("data", c => err.push(c));
    p.on("error", ko);
    p.on("close", code => code === 0 ? ok(Buffer.concat(out)) : ko(new Error("ffmpeg " + code + " " + Buffer.concat(err).toString().slice(0, 200))));
    p.stdin.on("error", () => {}); p.stdin.end(input);
  });
}
async function audioPourGemini(dataUrl){
  const a = AUDIO_RE.exec(String(dataUrl || ""));
  if(!a) return null;
  const mime = a[1] === "audio/x-wav" ? "audio/wav" : a[1] === "audio/mp3" ? "audio/mpeg" : a[1];
  if(["audio/wav", "audio/ogg", "audio/mpeg", "audio/aac", "audio/flac"].includes(mime)) return { b64: a[2], mime };
  const buf = Buffer.from(a[2], "base64");
  if(mime === "audio/webm") return { b64: (await ffmpeg(buf, ["-vn", "-c:a", "copy", "-f", "ogg"])).toString("base64"), mime: "audio/ogg" };
  if(mime === "audio/mp4" || mime === "audio/x-m4a") return { b64: (await ffmpeg(buf, ["-vn", "-c:a", "copy", "-f", "adts"])).toString("base64"), mime: "audio/aac" };
  // tout autre format : réencodage en Opus léger
  return { b64: (await ffmpeg(buf, ["-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg"])).toString("base64"), mime: "audio/ogg" };
}

// ---------- Lecture d'une photo de MODÈLE envoyée par la cliente ----------
// L'IA ne donne AUCUN chiffre de coupe : elle reconnaît seulement la forme du vêtement.
// Les chiffres sont calculés dans l'app avec les formules de coupe et les mesures de la cliente.
const OPTS = {
  structure: ["robe","ensemble","haut","jupe","pantalon","boubou"],
  haut: ["ajuste","ample"],
  encolure: ["ronde","v","carree","bateau","coeur","col","sans"],
  manche: ["sans","courte","troisquarts","longue","bouffante","evasee","kimono"],
  jupe: ["droite","crayon","evasee","sirene","cercle","demicercle","froncee","plissee","portefeuille"],
  longueur: ["mini","genou","mimollet","maxi"],
  bas: ["jupe","pantalon"]
};
function promptModele(genre){
  return `Tu es modéliste en Afrique de l'Ouest. Regarde la photo d'un vêtement (${genre === "homme" ? "pour homme" : "pour femme"}) qu'une cliente veut faire coudre.
Décris seulement sa FORME, avec ces choix (une seule valeur par champ, exactement comme écrit) :
- "structure" : ${OPTS.structure.join(" | ")}  (robe = une pièce ; ensemble = haut + bas séparés ; boubou = vêtement ample type boubou/kaftan)
- "haut" : ${OPTS.haut.join(" | ")}  (corsage près du corps ou ample)
- "encolure" : ${OPTS.encolure.join(" | ")}  (coeur = décolleté en cœur ; col = col chemise ou col montant)
- "manche" : ${OPTS.manche.join(" | ")}
- "bas" (seulement pour un ensemble) : ${OPTS.bas.join(" | ")}
- "jupe" (forme de la jupe ou du bas de robe) : ${OPTS.jupe.join(" | ")}
- "longueur" : ${OPTS.longueur.join(" | ")}
- "volantBas", "volantManche", "peplum", "ceinture", "fente" : true ou false
- "nom" : un nom court du modèle en français (ex. « Robe sirène à manches bouffantes »)
- "nomEn" : le même nom en anglais
- "conseils" : 2 à 4 conseils courts de montage en français (ordre de couture, tissu, finitions), sans aucun chiffre de mesure
- "confiance" : nombre entre 0 et 1
Si la photo ne montre pas de vêtement, mets "confiance": 0.
Réponds UNIQUEMENT en JSON avec ces clés.`;
}
function nettoieModele(r){
  const o = {};
  for(const k of ["structure","haut","encolure","manche","jupe","longueur","bas"]){ const v = String(r[k] || "").toLowerCase().replace(/[^a-z]/g, ""); if(OPTS[k].includes(v)) o[k] = v; }
  for(const k of ["volantBas","volantManche","peplum","ceinture","fente"]) o[k] = r[k] === true || r[k] === "true";
  o.nom = String(r.nom || "").slice(0, 80); o.nomEn = String(r.nomEn || "").slice(0, 80);
  o.conseils = (Array.isArray(r.conseils) ? r.conseils : []).map(x => String(x).slice(0, 160)).slice(0, 4);
  const c = parseFloat(r.confiance); o.confiance = isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
  return o;
}

// ---------- Dictée par la voix : l'IA écoute l'enregistrement et remplit la fiche ----------
function promptVoix(champs, genre, kind, today){
  const liste = champs.map(c => `- "${c[0]}" : ${c[1]}`).join("\n");
  return `Tu écoutes un enregistrement fait dans un atelier de couture en Gambie / Afrique de l'Ouest.
Le couturier dicte ${kind === "commande" ? "une COMMANDE (client, modèle, prix, avance, date de livraison, mesures)" : "la FICHE d'un client (nom, téléphone, homme ou femme, mesures)"}.
Il parle français ou anglais, parfois avec des mots wolof ou mandinka, souvent vite, avec des pauses et des répétitions.
Aujourd'hui nous sommes le ${today}.
Extrais ce qui est dit, en JSON :
- "nom" : nom complet du client, avec l'orthographe habituelle d'Afrique de l'Ouest (Fatou, Awa, Assatou, Aminata, Mariama, Isatou, Ousmane, Lamin, Ebrima, Modou ; Ceesay, Jallow, Diallo, Njie, Touray, Sanneh, Jobe, Bah, Barry, Camara, Sowe, Sallah, Jammeh, Bojang…). Sans « madame », « monsieur », « nom du client ».
- "telephone" : seulement les chiffres, dans l'ordre dit (ex. « 7 62 86 83 » → "7628683" ; « +220 » au début → "220…").
- "genre" : "homme" ou "femme" si c'est dit (madame/dame = femme, monsieur = homme), sinon rien.
- "mesures" : en centimètres, UNIQUEMENT avec ces clés :
${liste}
  « cent » est parfois entendu « sans » ou « sang » : c'est le nombre 100. « quatre-vingt-seize » = 96. « et demi » = .5.
  Un nombre dit juste après le nom d'une mesure appartient à cette mesure. Si une mesure est redite, garde la DERNIÈRE valeur (c'est une correction).
- "modele" : le vêtement commandé (ex. "robe sirène", "kaftan bazin"), si c'est dit.
- "prix" et "avance" : montants en dalasis (nombres), si c'est dit. « pas d'avance » = 0.
- "livraison" : date de livraison ou de rendez-vous au format AAAA-MM-JJ (« vendredi », « demain », « le 31 » se calculent à partir d'aujourd'hui), si c'est dit.
- "notes" : remarque utile dite en plus (tissu, couleur, urgence), sinon rien.
- "transcription" : ce que tu as entendu, mot à mot, court.
Règles : n'invente rien ; si quelque chose n'est pas dit, ne mets pas la clé. Réponds UNIQUEMENT en JSON.`;
}
function nettoieVoix(r, ok){
  const o = {};
  const nom = String(r.nom || "").replace(/\s+/g, " ").trim(); if(nom && nom.length < 80) o.nom = nom;
  const tel = String(r.telephone || "").replace(/[^0-9]/g, ""); if(tel.length >= 3 && tel.length <= 15) o.telephone = tel;
  const g = String(r.genre || "").toLowerCase(); if(g === "homme" || g === "femme") o.genre = g;
  const m = {}; Object.entries(r.mesures || {}).forEach(([k, v]) => { const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", ".")); if(ok.has(k) && isFinite(n) && n > 0 && n < 400) m[k] = Math.round(n * 2) / 2; });
  if(Object.keys(m).length) o.mesures = m;
  const md = String(r.modele || "").trim(); if(md && md.length < 120) o.modele = md;
  for(const k of ["prix", "avance"]){ const n = parseFloat(String(r[k] ?? "").replace(/[^0-9.,]/g, "").replace(",", ".")); if(isFinite(n) && n >= 0 && n < 10000000 && String(r[k] ?? "") !== "") o[k] = n; }
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(r.livraison || ""))) o.livraison = r.livraison;
  const nt = String(r.notes || "").trim(); if(nt && nt.length < 300) o.notes = nt;
  o.transcription = String(r.transcription || "").slice(0, 600);
  return o;
}
// ---------- Assistant vocal : une phrase libre → une action dans l'app ----------
const ACTIONS = ["ouvrir", "commande", "client", "fiche", "chercher", "voir_commande", "question", "confirmer", "annuler", "retour", "aide", "rien"];
const SUJETS = ["recettes_jour", "recettes_semaine", "recettes_mois", "impayes", "retard", "pretes", "a_livrer_aujourdhui", "en_cours"];
function promptAssistant(champs, today, ctx){
  const liste = champs.map(c => `"${c[0]}" (${c[1]})`).join(", ");
  return `Tu es l'assistant vocal de SanaaPro, l'application de gestion d'un atelier de couture en Gambie / Afrique de l'Ouest.
Beaucoup d'utilisateurs ne sont pas allés à l'école : ils parlent, ils n'écrivent pas. Ils parlent français ou anglais, avec l'accent
d'Afrique de l'Ouest, parfois des mots wolof ou mandinka, souvent vite, avec des hésitations (« euh », « bon », « c'est-à-dire »).
Aujourd'hui nous sommes le ${today}. Écran ouvert : ${ctx.ecran || "accueil"}.${ctx.attente ? `
L'application vient de poser cette question : « ${ctx.attente} ». Si la personne répond oui / d'accord / vas-y / enregistre / yes / ok → action "confirmer" ; non / attends / laisse / no → "annuler".` : ""}

Si l'écran ouvert est « cform » (formulaire de commande), toute information dite (nom, numéro, vêtement, prix, avance, date, mesures) → action "commande" : elle complète la commande en cours.
Si l'écran ouvert est « form » (fiche client), toute information dite → action "client".

Écoute l'enregistrement et choisis UNE action :
- "ouvrir" : aller sur un écran. Champ "onglet" parmi : ${ctx.onglets.join(", ")}.
  (atelier = commandes de couture ; pressing = blanchisserie ; mesures = liste des clients ; finances = argent, caisse ; staff = salariés ; visits = visiteurs ; charge = planning de la semaine ; vitrine = catalogue de modèles ; reglages = paramètres)
- "commande" : la personne décrit une NOUVELLE commande de couture (un client + un vêtement, et souvent prix, avance, date, mesures).
- "client" : la personne crée un NOUVEAU client ou dicte des mesures / un numéro pour un client, sans parler de vêtement à coudre.
- "fiche" : ouvrir la fiche d'un client existant (« ouvre Awa Jallow », « les mesures de Fatou »).
- "chercher" : chercher un client ou une commande par un mot (nom incomplet, numéro de téléphone).
- "voir_commande" : ouvrir une commande précise (« la commande 59 », « la robe de Rokey »).
- "question" : la personne demande une information. Champ "sujet" parmi : ${SUJETS.join(", ")}
  (combien gagné aujourd'hui / cette semaine / ce mois ; qui doit de l'argent ; ce qui est en retard ; ce qui est prêt ; ce qu'il faut livrer aujourd'hui ; ce qui est en cours).
- "confirmer" / "annuler" : réponse oui / non à la question posée par l'application.
- "retour" : revenir en arrière. "aide" : la personne demande ce qu'elle peut dire. "rien" : bruit, phrase vide ou incompréhensible.

Champs à extraire quand c'est dit (sinon ne mets pas la clé) :
- "nom" : nom du client, orthographe habituelle d'Afrique de l'Ouest (Fatou, Awa, Assatou, Aminata, Mariama, Isatou, Rohey, Kaddy, Ousmane, Lamin, Ebrima, Modou ; Ceesay, Jallow, Diallo, Njie, Touray, Sanneh, Jobe, Bah, Barry, Camara, Sowe, Jammeh, Bojang, Traoré…), sans « madame », « monsieur ».
- "telephone" : seulement les chiffres, dans l'ordre dit (« sept cent soixante-deux, quatre-vingt-six, quatre-vingt-trois » → "7628683" ; « +220 » au début → "220…").
- "genre" : "homme" ou "femme" si c'est dit ou évident (madame, elle, sa robe → femme ; monsieur, kaftan d'homme → homme).
- "articles" : liste des vêtements commandés, [{"nom": "robe sirène", "prix": 3000}] — prix en dalasis, seulement s'il est dit pour ce vêtement.
- "prix" : prix total s'il est dit sans détail par vêtement.
- "avance" : somme déjà donnée (« elle a donné 1000 », « pas d'avance » = 0).
- "livraison" : date de livraison / rendez-vous AAAA-MM-JJ (« vendredi », « demain », « dans une semaine », « le 31 » se calculent depuis aujourd'hui).
- "type" : "confection" (coudre du neuf), "retouche" (réparer, ajuster, raccourcir) ou "pap" (prêt-à-porter déjà fait).
- "recu" : ce que le client a laissé : "tissu", "materiel" ou "vetement".
- "mesures" : en cm, UNIQUEMENT avec ces clés : ${liste}.
  « cent » est parfois entendu « sans » ou « sang » = 100. « et demi » = .5. Un nombre dit juste après une mesure lui appartient. Mesure redite = garder la DERNIÈRE.
- "notes" : détail utile (couleur, tissu, modèle, urgence), court.
- "recherche" : le mot à chercher (pour "chercher", "fiche", "voir_commande").
- "numero" : numéro de reçu de la commande (« la 59 » → 59).
- "onglet", "sujet" : voir plus haut.
- "transcription" : ce que tu as entendu, mot à mot, court.
- "langue" : "fr" si la personne a parlé surtout français, "en" si surtout anglais.
- "reponse" : ce que l'application va DIRE à voix haute, DANS LA LANGUE DE LA PERSONNE, une phrase courte et chaleureuse qui répète l'essentiel compris
  (ex. « Commande pour Awa Jallow, une robe sirène à 3000 dalasis, livraison vendredi. »). Pour "rien" : demande gentiment de répéter.
Règles : n'invente rien ; les montants sont des nombres sans unité. Réponds UNIQUEMENT en JSON :
{"action":"","onglet":"","sujet":"","nom":"","telephone":"","genre":"","articles":[],"prix":0,"avance":0,"livraison":"","type":"","recu":"","mesures":{},"notes":"","recherche":"","numero":0,"transcription":"","langue":"","reponse":""}`;
}
const num = v => { if(v === null || v === undefined || v === "") return undefined; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.,-]/g, "").replace(",", ".")); return isFinite(n) ? n : undefined; };
function nettoieAssistant(r, ok, ctx){
  const o = {};
  o.action = ACTIONS.includes(r.action) ? r.action : "rien";
  if(r.onglet && ctx.onglets.includes(r.onglet)) o.onglet = r.onglet;
  if(o.action === "ouvrir" && !o.onglet) o.action = "rien";
  if(SUJETS.includes(r.sujet)) o.sujet = r.sujet;
  if(o.action === "question" && !o.sujet) o.action = "rien";
  const nom = String(r.nom || "").replace(/\s+/g, " ").trim(); if(nom && nom.length < 80) o.nom = nom;
  const tel = String(r.telephone || "").replace(/[^0-9]/g, ""); if(tel.length >= 3 && tel.length <= 15) o.telephone = tel;
  const g = String(r.genre || "").toLowerCase(); if(g === "homme" || g === "femme") o.genre = g;
  const arts = (Array.isArray(r.articles) ? r.articles : []).map(x => ({ nom: String((x && x.nom) || "").trim().slice(0, 120), prix: num(x && x.prix) }))
    .filter(x => x.nom).slice(0, 20).map(x => (x.prix !== undefined && x.prix >= 0 && x.prix < 10000000) ? x : { nom: x.nom });
  if(arts.length) o.articles = arts;
  for(const k of ["prix", "avance"]){ const n = num(r[k]); if(n !== undefined && n >= 0 && n < 10000000 && !(n === 0 && k === "prix")) o[k] = n; }
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(r.livraison || ""))) o.livraison = r.livraison;
  if(["confection", "retouche", "pap"].includes(r.type)) o.type = r.type;
  if(["tissu", "materiel", "vetement"].includes(r.recu)) o.recu = r.recu;
  const m = {}; Object.entries(r.mesures || {}).forEach(([k, v]) => { const n = num(v); if(ok.has(k) && n !== undefined && n > 0 && n < 400) m[k] = Math.round(n * 2) / 2; });
  if(Object.keys(m).length) o.mesures = m;
  const nt = String(r.notes || "").trim(); if(nt && nt.length < 300) o.notes = nt;
  const q = String(r.recherche || "").trim(); if(q && q.length < 80) o.recherche = q;
  const n = num(r.numero); if(n !== undefined && n > 0 && n < 1000000) o.numero = Math.round(n);
  o.transcription = String(r.transcription || "").slice(0, 600);
  o.reponse = String(r.reponse || "").slice(0, 300);
  o.langue = r.langue === "en" || r.langue === "fr" ? r.langue : ctx.langue;
  return o;
}

http.createServer(async (req, res) => {
  cors(req, res);
  if(req.method === "OPTIONS"){ res.writeHead(204); return res.end(); }
  const path = (req.url || "/").split("?")[0];
  if(req.method === "GET") return send(res, 200, { ok: true, service: "sanaapro-lecteur-cahier", pret: !!KEY });
  if(req.method !== "POST" || (path !== "/lire" && path !== "/modele" && path !== "/voix" && path !== "/assistant")) return send(res, 404, { error: "not_found" });
  if(!KEY) return send(res, 503, { error: "no_key" });

  const uid = await uidFrom(req);
  if(!uid) return send(res, 401, { error: "auth" });
  if(!allow(uid)) return send(res, 429, { error: "limit" });

  let body;
  try{ body = JSON.parse(await readBody(req)); }catch(e){ return send(res, 413, { error: "body" }); }
  if(path === "/assistant"){
    let a; try{ a = await audioPourGemini(body.audio); }catch(e){ console.log("erreur son", e.message); return send(res, 400, { error: "audio" }); }
    if(!a) return send(res, 400, { error: "audio" });
    const champs = Array.isArray(body.champs) ? body.champs.filter(c => Array.isArray(c) && /^[A-Za-z]{2,30}$/.test(c[0])).slice(0, 60).map(c => [c[0], String(c[1] || c[0]).slice(0, 60)]) : [];
    const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body.today || "")) ? body.today : new Date().toISOString().slice(0, 10);
    const ctx = {
      ecran: String(body.ecran || "").slice(0, 40),
      attente: String(body.attente || "").slice(0, 300),
      langue: body.langue === "en" ? "en" : "fr",
      onglets: Array.isArray(body.onglets) ? body.onglets.filter(x => /^[a-z]{2,20}$/.test(x)).slice(0, 20) : [],
      manager: !!body.manager
    };
    try{
      const t0 = Date.now();
      const r = await gemini(a.b64, a.mime, promptAssistant(champs, today, ctx), { rapide: true });
      const out = nettoieAssistant(r || {}, new Set(champs.map(c => c[0])), ctx);
      send(res, 200, out);
      console.log("assistant", uid.slice(0, 6), out.action, r && r._model, a.mime, Math.round(a.b64.length * 0.75 / 1024) + " Ko", (Date.now() - t0) + " ms");
    }catch(e){ console.log("erreur assistant", e.message); send(res, 502, { error: "read" }); }
    return;
  }
  if(path === "/voix"){
    let a; try{ a = await audioPourGemini(body.audio); }catch(e){ console.log("erreur son", e.message); return send(res, 400, { error: "audio" }); }
    if(!a) return send(res, 400, { error: "audio" });
    const champs = Array.isArray(body.champs) ? body.champs.filter(c => Array.isArray(c) && /^[A-Za-z]{2,30}$/.test(c[0])).slice(0, 60).map(c => [c[0], String(c[1] || c[0]).slice(0, 60)]) : [];
    const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body.today || "")) ? body.today : new Date().toISOString().slice(0, 10);
    try{
      const t0 = Date.now();
      const r = await gemini(a.b64, a.mime, promptVoix(champs, body.genre, body.kind === "commande" ? "commande" : "client", today), { rapide: true });
      send(res, 200, nettoieVoix(r || {}, new Set(champs.map(c => c[0]))));
      console.log("voix", uid.slice(0, 6), r && r._model, a.mime, Math.round(a.b64.length * 0.75 / 1024) + " Ko", (Date.now() - t0) + " ms");
    }catch(e){ console.log("erreur voix", e.message); send(res, 502, { error: "read" }); }
    return;
  }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ""));
  if(!m) return send(res, 400, { error: "image" });
  if(path === "/modele"){
    try{
      const r = await gemini(m[2], m[1], promptModele(body.genre));
      send(res, 200, nettoieModele(r || {}));
      console.log("modèle", uid.slice(0, 6), r && r._model);
    }catch(e){ console.log("erreur modèle", e.message); send(res, 502, { error: "read" }); }
    return;
  }
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
  try{ const out = await ffmpeg(Buffer.alloc(0), ["-version"]).catch(e => { throw e; }); console.log("AUTOTEST ffmpeg OK", out.length); }
  catch(e){
    // « -i pipe:0 -version » échoue sans entrée : on lance juste le binaire pour voir s'il existe
    await new Promise(ok => { const p = spawn(ffmpegPath, ["-version"]); let t = ""; p.stdout.on("data", c => t += c); p.on("error", er => { console.log("AUTOTEST ffmpeg ABSENT", ffmpegPath, er.message); ok(); }); p.on("close", c => { if(c === 0) console.log("AUTOTEST ffmpeg OK", t.split("\n")[0]); ok(); }); });
  }
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
