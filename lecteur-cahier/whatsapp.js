// Assistant WhatsApp Chez Djamil (numéro +220 762 8683, branché à Bird en coexistence)
// Bird envoie chaque message reçu à POST /bird-whatsapp ; Gemini écrit la réponse ; on la renvoie par Bird.
// Variables Render : BIRD_API_KEY, BIRD_WEBHOOK_SECRET, GEMINI_API_KEY (déjà là),
//   WHATSAPP_BOT=off pour tout couper, SILENCE_NUMBERS="+220...,+220..." numéros à ne jamais servir.
import crypto from "node:crypto";

const BUSINESS = "+2207628683";
const H = 3600 * 1000;
const KEY_BIRD = () => process.env.BIRD_API_KEY || "";
const SECRET = () => process.env.BIRD_WEBHOOK_SECRET || "";
const MODELS = [process.env.GEMINI_CHAT_MODEL, "gemini-flash-latest", "gemini-3-flash-preview", "gemini-3.1-flash-lite"].filter(Boolean);

export const CONNAISSANCES = `
CHEZ DJAMIL — Bakau New Town, The Gambia. One WhatsApp number (762 8683) for three activities:
the tailoring workshop (atelier), the dry cleaning (Djamil Laundry / pressing) and the fashion school DAFD Académie.
Website: chezdjamil.com. Founder: Djamil (Moriba Traoré), more than 20 years of experience in fashion design.

OPENING HOURS
- Workshop, dry cleaning and shop: Monday to Saturday, 9:00 am to 6:00 pm. Closed on Sunday.
- School office (to register and get the payment plan): Monday to Thursday, 8:00 am to 2:00 pm.

1) TAILORING (made to measure, women and men)
- Confection (new outfit), alterations (retouche) and ready-to-wear.
- Prices depend on the model and the fabric: NEVER give a price. Ask the customer to send a photo of the model,
  say if they already have the fabric, and give their deadline; the team will send the price.
- Measurements are taken at the workshop.
- Order follow-up: ask the customer's name and receipt/order number; the team will check and answer.
- December is the busy month: advise to order early.

2) DRY CLEANING — Djamil Laundry (prices in dalasi, per item; white clothes cost more)
Full suit and trousers D450 (white D500) · Suit jacket only D300 (white D350) · Jacket D350 · Long coat D325
African full dress long sleeve D350 (white D450) · short sleeve D300 (white D400)
Men African kaftan long sleeve D350 (white D400) · short sleeve D300 (white D350)
European dress D500 (white D600) · Gown D350 · Lace dress D450 · Long lady dress D250 · Francky dress D650
Long sleeve shirt D100 (white D150) · Short sleeve shirt D75 (white D125) · T-shirt long sleeve D100 · short sleeve D75
Men trouser D150 (white D200) · Ladies trouser D150 (white D200) · Jeans D150 (white D200) · Skirt D100
Bed sheet big D1500 · small D800 · Pillow case D50 · Blanket big D800 · small D500 · Window curtains D100 · Towels D100 · Legal bands D50
- EXPRESS (same day): 50% more than the normal price.
- Pick-up and delivery at home are possible: ask the address (area + landmark), the items and the day/time;
  the team confirms the time and the delivery cost.
- Ticket follow-up: ask name and ticket number; the team checks.

3) FASHION SCHOOL — DAFD Académie (Djamil Academy of Fashion Design)
- Pattern-making, cutting, sewing and design. Open to everyone from 14 years old, no school level required.
- 2-year programme, the 2 years are needed for the diploma. Each year has 3 trimesters.
  Someone who already sews can take a level test and may enter directly in 2nd year.
- The morning class is full (only for people with experience). New students join:
  * Afternoon class: Monday to Thursday, 3:30 pm to 6:30 pm (for students and people who work in the morning).
  * Weekend class: Friday and Saturday, 9:00 am to 2:00 pm (for people who work during the week).
- Fees, 1st year:
  * One time: application form D200, registration D2,500, uniform D1,750 (no uniform for the weekend class).
  * Each trimester: tuition D19,500 (weekend class D16,500), machine maintenance D500, student workbook D1,000.
  * The 2nd year is paid only when the student passes to 2nd year.
  * Payment is flexible: a payment plan is given at the school office.
- It is not too late, new students are still welcome. To register: come to the school in Bakau New Town
  (Monday–Thursday, 8 am–2 pm) or fill the form on chezdjamil.com.
- Djamil wants students who love the work, with patience and courage; the decision must come from the student,
  not forced by the parents.

PAYMENT: cash or Wave. The team gives the Wave details when needed.
`;

const REGLES = `You answer WhatsApp messages for Chez Djamil, a small business in The Gambia, as "Chez Djamil".
Rules:
- Reply in the customer's language: English or French. If they write in Wolof, Mandinka or another language, answer in simple English.
- Short WhatsApp style: 1 to 5 short lines, warm and polite, simple words (many customers did not go to school). At most one emoji. No long lists unless they ask for prices.
- Use ONLY the information below. Never invent a price, a date, a delay, a discount or a promise. If you do not know, say a team member will answer.
- Never say an order is ready or a payment is received: you cannot see the orders.
- Do not pretend to be a human. If asked, say you are Chez Djamil's automatic assistant and a team member can take over.
- Set "handoff" to true when: the customer asks for a person/Djamil/a call, complains or is angry, talks about money already paid or a problem with an order,
  wants a price for tailoring after sending the model, gives a pick-up address to confirm, or the request is outside this information.
  When handoff is true, the reply says kindly that a team member will answer soon (and the call number 762 8683 if useful).
- Set "reply" to "" (empty) if the message needs no answer (just "ok", "thanks", an emoji, a sticker) after the conversation is finished.
Answer ONLY in JSON: {"reply":"...","handoff":false}`;

// ---------- mémoire courte (en RAM) ----------
const histo = new Map();      // contact -> [{r:"client"|"nous", t, at}]
const humain = new Map();     // contact -> silence jusqu'à (ms)
const vus = new Map();        // webhook-id -> ms (anti-doublon)
const quota = new Map();      // contact -> {jour, n}
const enAttente = new Map();  // contact -> timer (regroupe les messages rapides)

function noter(c, r, t){
  const a = (histo.get(c) || []).filter(x => Date.now() - x.at < 24 * H);
  a.push({ r, t: String(t).slice(0, 800), at: Date.now() });
  histo.set(c, a.slice(-14));
}

export function signatureOk(raw, headers, secret = SECRET(), now = Date.now()){
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"] || "";
  if(!id || !ts || !secret) return false;
  if(Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const attendu = crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
  return sig.split(" ").some(p => {
    const s = Buffer.from(p.replace(/^v1,/, ""), "base64");
    return s.length === attendu.length && crypto.timingSafeEqual(s, attendu);
  });
}

function hote(){ const m = KEY_BIRD().match(/^b[km]_([a-z0-9]+)_/); return `https://${m ? m[1] : "us1"}.platform.bird.com`; }

async function bird(method, path, body){
  const r = await fetch(hote() + path, { method, headers: { Authorization: "Bearer " + KEY_BIRD(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try{ j = JSON.parse(t); }catch(e){}
  if(!r.ok) throw new Error("bird_" + r.status + " " + t.slice(0, 200));
  return j;
}

// L'équipe a-t-elle répondu elle-même depuis l'appli WhatsApp Business ces dernières heures ?
async function equipeARepondu(contact){
  try{
    const depuis = new Date(Date.now() - 6 * H).toISOString();
    const j = await bird("GET", `/v1/whatsapp/messages?direction=outbound&to=${encodeURIComponent(contact)}&created_after=${encodeURIComponent(depuis)}&limit=30`);
    return (j.data || []).some(m => m.origin === "business_app_echo");
  }catch(e){ console.log("WA vérif équipe :", e.message); return false; }
}

async function envoyer(contact, texte){
  await bird("POST", "/v1/whatsapp/messages", { from: BUSINESS, to: contact, text: { body: texte }, tags: [{ name: "source", value: "assistant" }] });
}

async function rediger(contact, geminiKey){
  const conv = (histo.get(contact) || []).map(x => (x.r === "client" ? "Customer: " : "Chez Djamil: ") + x.t).join("\n");
  const texte = `${REGLES}\n\nINFORMATION:\n${CONNAISSANCES}\n\nCONVERSATION (last 24 h):\n${conv}\n\nWrite the next Chez Djamil message.`;
  for(const model of MODELS){
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: texte }] }], generationConfig: { temperature: 0.3, responseMimeType: "application/json" } })
    });
    if(!r.ok){ console.log("WA gemini", model, r.status); continue; }
    const j = await r.json();
    const txt = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || "").join("") || "{}";
    try{ const o = JSON.parse(txt.replace(/^```json|```$/g, "").trim()); return { reply: String(o.reply || "").trim().slice(0, 1500), handoff: !!o.handoff }; }
    catch(e){ console.log("WA réponse illisible", txt.slice(0, 120)); }
  }
  return null;
}

export function contenuLisible(d){
  if(d.text && d.text.body) return d.text.body;
  if(d.interactive_reply) return d.interactive_reply.title || d.interactive_reply.id || "[reply]";
  for(const k of ["image", "video", "document", "audio", "sticker", "location", "contact_cards"]){
    if(d[k]){ const cap = d[k].caption ? " " + d[k].caption : ""; return `[${k === "audio" ? "voice note" : k}]${cap}`; }
  }
  return "";
}

async function traiter(contact, geminiKey){
  enAttente.delete(contact);
  if((humain.get(contact) || 0) > Date.now()) return;
  if(await equipeARepondu(contact)){ humain.set(contact, Date.now() + 6 * H); console.log("WA équipe active, silence", contact.slice(-4)); return; }
  const jour = new Date().toISOString().slice(0, 10), q = quota.get(contact);
  const n = q && q.jour === jour ? q.n : 0;
  if(n >= 25){ console.log("WA quota atteint", contact.slice(-4)); return; }
  const o = await rediger(contact, geminiKey);
  if(!o || !o.reply) return;
  await envoyer(contact, o.reply);
  quota.set(contact, { jour, n: n + 1 });
  noter(contact, "nous", o.reply);
  if(o.handoff) humain.set(contact, Date.now() + 12 * H);
  console.log("WA réponse envoyée", contact.slice(-4), o.handoff ? "(relais équipe)" : "");
}

// Point d'entrée appelé par le serveur pour POST /bird-whatsapp
export async function webhookBird(req, res, raw, geminiKey){
  if(!signatureOk(raw, req.headers)){ res.writeHead(400); return res.end("signature"); }
  res.writeHead(200); res.end("ok");
  const id = req.headers["webhook-id"];
  if(vus.has(id)) return;
  vus.set(id, Date.now()); if(vus.size > 2000) for(const [k, t] of vus) if(Date.now() - t > 24 * H) vus.delete(k);
  let ev; try{ ev = JSON.parse(raw); }catch(e){ return; }
  if(ev.test){ console.log("WA test Bird reçu"); return; }
  if(ev.type !== "whatsapp.received") return;
  const d = ev.data || {};
  if(process.env.WHATSAPP_BOT === "off") return;
  if(!d.from || (d.to && d.to.group_id) || d.group_id) return;              // pas de groupes
  if(d.to && d.to.phone_number && d.to.phone_number !== BUSINESS) return;
  const contact = d.from.phone_number || d.from.bsuid;
  if(!contact) return;
  const silence = (process.env.SILENCE_NUMBERS || "").split(",").map(s => s.trim()).filter(Boolean);
  if(silence.includes(contact)) return;
  const texte = contenuLisible(d);
  if(!texte) return;
  noter(contact, "client", texte);
  console.log("WA message reçu de", contact.slice(-4));
  // on attend 6 s : un client envoie souvent plusieurs messages d'affilée
  clearTimeout(enAttente.get(contact));
  enAttente.set(contact, setTimeout(() => traiter(contact, geminiKey).catch(e => console.log("WA erreur", e.message)), 6000));
}

// Pour un test manuel sans rien envoyer : rédige la réponse à une conversation donnée.
export async function essai(messages, geminiKey){
  const c = "essai-" + Math.random();
  for(const m of messages) noter(c, "client", m);
  const o = await rediger(c, geminiKey); histo.delete(c); return o;
}
