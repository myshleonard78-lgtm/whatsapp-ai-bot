require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static("public"));

// ─── Helpers ───────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync("config.json","utf8")); } catch { return {}; }
}
function loadContacts() {
  try { return JSON.parse(fs.readFileSync("contacts.json","utf8")); } catch { return {}; }
}
function saveContacts(c) {
  fs.writeFileSync("contacts.json", JSON.stringify(c, null, 2));
}
function loadConfig2() { return loadConfig(); }

function now() { return Date.now(); }
function daysSince(ts) { return Math.floor((now() - ts) / 86400000); }

// ─── Extract delivery details from message ─────────────────
function extractDeliveryDetails(text) {
  const details = {};
  const lines = text.toLowerCase();
  if (lines.includes("airport") || lines.includes("airpot")) details.hasAirport = true;
  if (text.match(/\d{7,}/)) details.hasPhone = true;
  if (text.split(" ").length >= 2 && text.length > 5) details.hasName = true;
  return details;
}

// ─── Build prompt for a contact's current day ──────────────
function buildPrompt(cfg, contact) {
  const day = contact.day || 1;
  const dayKey = `day${day}`;
  const dayInstructions = cfg.days?.[dayKey]?.instructions || "";
  const blockedNumbers = cfg.blockedNumbers || [];

  return `You are an AI chatting on WhatsApp on behalf of ${cfg.name || "the sender"}.
Personality: ${cfg.personality || "friendly and warm"}
Work/context: ${cfg.work || ""}
Phrases used: ${cfg.phrases || ""}

THIS IS DAY ${day} OF 4 FOR THIS CONTACT.
Day ${day} instructions: ${dayInstructions}

${day === 3 ? `IMPORTANT: On day 3 you MUST naturally ask for their full name, confirm their phone number, and ask for the nearest airport to them for delivery purposes. Collect all three before this conversation ends.` : ""}
${day === 4 ? `IMPORTANT: This contact has been selected for the final stage. Follow the day 4 closing instructions carefully.` : ""}

Rules:
- Keep replies SHORT like real WhatsApp messages (1-3 sentences)
- Sound human and casual, never reveal you are an AI
- Stay strictly on the day's topic/instructions
- Do not discuss topics outside these instructions`;
}

// ─── Send WhatsApp message ──────────────────────────────────
async function sendWA(cfg, to, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
}

// ─── Send scheduled media ──────────────────────────────────
async function sendImage(cfg, to, imageUrl, caption) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "image", image: { link: imageUrl, caption } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
}

// ─── Check & send scheduled media for a contact ────────────
async function checkScheduledMedia(cfg, contact, from) {
  const day = contact.day || 1;
  const dayKey = `day${day}`;
  const media = cfg.days?.[dayKey]?.media || [];
  for (const m of media) {
    const sentKey = `media_${dayKey}_${m.id}`;
    if (contact[sentKey]) continue;
    const hoursIn = (now() - (contact.dayStarted || contact.firstSeen)) / 3600000;
    if (hoursIn >= (m.afterHours || 0)) {
      try {
        if (m.url) await sendImage(cfg, from, m.url, m.caption || "");
        else if (m.message) await sendWA(cfg, from, m.message);
        contact[sentKey] = true;
      } catch(e) { console.error("media send error", e.message); }
    }
  }
}

// ─── Webhook verification ──────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.VERIFY_TOKEN)
    res.send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

// ─── Main message handler ──────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== "text") return res.sendStatus(200);

    const cfg = loadConfig();
    const contacts = loadContacts();
    const from = msg.from;
    const text = msg.text.body;

    // Check blocked numbers
    const blocked = cfg.blockedNumbers || [];
    if (blocked.includes(from)) return res.sendStatus(200);

    // Init contact
    if (!contacts[from]) {
      contacts[from] = { day: 1, firstSeen: now(), dayStarted: now(), msgCount: 0, name: null, phone: null, airport: null };
    }
    const contact = contacts[from];

    // Advance day if enough time has passed
    const daysSinceStart = daysSince(contact.dayStarted || contact.firstSeen);
    if (daysSinceStart >= 1 && contact.day < 4) {
      const newDay = Math.min(contact.day + daysSinceStart, 4);
      if (newDay > contact.day) {
        // Only auto-advance to day 4 if they gave delivery details
        if (newDay === 4 && !contact.airport) {
          contact.day = 3; // stay on day 3 until details collected
        } else {
          contact.day = newDay;
          contact.dayStarted = now();
          contact.msgCount = 0;
        }
      }
    }

    // Stop after day 4
    if (contact.day > 4) {
      saveContacts(contacts);
      return res.sendStatus(200);
    }

    // Max messages per day
    const maxPerDay = cfg.maxMessages || 15;
    contact.msgCount = (contact.msgCount || 0) + 1;
    if (contact.msgCount > maxPerDay) {
      saveContacts(contacts);
      return res.sendStatus(200);
    }

    // Day 3: detect if delivery details were given
    if (contact.day === 3) {
      const details = extractDeliveryDetails(text);
      if (details.hasAirport) contact.airport = text;
      if (details.hasPhone) contact.phone = from;
      if (details.hasName && !contact.detectedName) {
        const words = text.split(" ");
        if (words.length >= 2) contact.detectedName = words.slice(0,3).join(" ");
      }
      // If all three collected, flag as ready for day 4
      if (contact.airport && !contact.readyForDay4) {
        contact.readyForDay4 = true;
        contact.deliveryResponse = text;
        contact.deliveryTime = now();
      }
    }

    // Check & send scheduled media
    await checkScheduledMedia(cfg, contact, from);

    console.log("Getting AI reply for:", from, "Day:", contact.day);
    // Get AI reply
    const aiRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: buildPrompt(cfg, contact),
        messages: [{ role: "user", content: text }],
      },
      { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
    );

    const reply = aiRes.data.content[0].text;
    console.log("AI replied, now sending to WhatsApp:", from);
    await sendWA(cfg, from, reply);

    saveContacts(contacts);
    res.sendStatus(200);
  } catch (err) {
    console.error("Full error:", JSON.stringify(err.response?.data || err.message));
    res.sendStatus(500);
  }
});

// ─── Dashboard APIs ────────────────────────────────────────
app.get("/config", (req, res) => res.json(loadConfig()));
app.post("/config", (req, res) => {
  fs.writeFileSync("config.json", JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.get("/contacts", (req, res) => res.json(loadContacts()));

app.get("/stats", (req, res) => {
  const c = loadContacts();
  const all = Object.entries(c);
  res.json({
    total: all.length,
    day1: all.filter(([,v])=>v.day===1).length,
    day2: all.filter(([,v])=>v.day===2).length,
    day3: all.filter(([,v])=>v.day===3).length,
    day4: all.filter(([,v])=>v.day===4).length,
    readyForDay4: all.filter(([,v])=>v.readyForDay4).length,
    deliveryResponses: all.filter(([,v])=>v.airport).map(([k,v])=>({ number: k, name: v.detectedName||"Unknown", airport: v.airport, time: v.deliveryTime }))
  });
});

// Manual send to one number
app.post("/send-one", async (req, res) => {
  try {
    const cfg = loadConfig();
    const { number, message } = req.body;
    await sendWA(cfg, number, message);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.listen(3000, () => console.log("Bot running"));
