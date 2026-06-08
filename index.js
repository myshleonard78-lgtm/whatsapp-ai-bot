require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ============================================================
//  EDIT ONLY THIS SECTION — everything else leave as it is
// ============================================================
const NAME        = "Brian";
const PERSONALITY = "chill, funny, direct, uses slang like 'sawa sawa'";
const WORK        = "I run a digital marketing agency in Nairobi. I do social media, branding and content for small businesses.";
const PHRASES     = "sawa sawa, wacha nikuambie, lmk, nitakupigia simu, pole";
const OFF_LIMITS  = "personal finances, family matters, politics";
// ============================================================

const SYSTEM_PROMPT = `You are an AI replying on WhatsApp on behalf of ${NAME}.
Personality: ${PERSONALITY}
Work: ${WORK}
Phrases ${NAME} uses: ${PHRASES}
Never talk about: ${OFF_LIMITS}
Rules:
- Keep replies SHORT like real WhatsApp messages (1-3 sentences max)
- Sound human and casual, match the energy of the message
- Never reveal you are an AI
- If asked about off-limits topics, deflect naturally`;

// WhatsApp webhook verification
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// Receive and reply to messages
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== "text") return res.sendStatus(200);

    const from = msg.from;
    const text = msg.text.body;

    const aiRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: text }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    const reply = aiRes.data.content[0].text;

    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to: from, text: { body: reply } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error(err.message);
    res.sendStatus(500);
  }
});

app.listen(3000, () => console.log("Bot is running..."));
