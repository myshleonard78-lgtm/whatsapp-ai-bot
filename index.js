require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// ─── Config ────────────────────────────────────────────────
// Reuses the exact same env var names as before (WHATSAPP_PHONE_ID,
// WHATSAPP_TOKEN, VERIFY_TOKEN, ANTHROPIC_API_KEY) so nothing in Meta's
// dashboard or Render's existing env vars needs to change.
const OWNER_NUMBER = process.env.OWNER_WHATSAPP_NUMBER || "254745344649";
const TRADING_SERVER_URL = process.env.TRADING_SERVER_URL || "https://forex-trading-server.onrender.com";
const TRADING_SERVER_SECRET = process.env.TRADING_SERVER_SECRET;
const HISTORY_PATH = path.join(__dirname, "conversations.json");
const GRAPH_VERSION = "v18.0";

// ─── Conversation memory (short, per-sender) ────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch { return {}; }
}
function saveHistory(h) { fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2)); }

// ─── Send a WhatsApp text message ───────────────────────────
async function sendWA(to, text) {
  await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
}

// ─── Download an incoming WhatsApp image as base64 ──────────
async function downloadWhatsAppMedia(mediaId) {
  const metaRes = await axios.get(
    `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
  const { url, mime_type } = metaRes.data;
  const fileRes = await axios.get(url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
  });
  return { base64: Buffer.from(fileRes.data).toString("base64"), mimeType: mime_type };
}

// ─── Trading server API helpers ─────────────────────────────
async function tradingGet(endpoint, extraParams = {}) {
  const res = await axios.get(`${TRADING_SERVER_URL}${endpoint}`, {
    params: { key: TRADING_SERVER_SECRET, ...extraParams },
  });
  return res.data;
}
async function tradingPost(endpoint, body = {}) {
  const res = await axios.post(`${TRADING_SERVER_URL}${endpoint}`, {
    secret: TRADING_SERVER_SECRET,
    ...body,
  });
  return res.data;
}

// ─── Claude tool definitions ─────────────────────────────────
const TOOLS = [
  {
    name: "get_status",
    description: "Get the full current state of the trading bot: mode (demo/live), connection health, balance, today's loss vs the daily cap, every open position, and every strategy's trial progress (trade count, win rate, profit factor, drawdown).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "halt_trading",
    description: "Immediately stop the trading bot from placing any new trades. Does not close existing open positions.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "Why trading is being halted" } },
    },
  },
  {
    name: "resume_trading",
    description: "Resume trading after a halt.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "switch_mode",
    description: "Switch the bot between the demo account and the real (live) account. Use live only when explicitly asked, since it trades real money.",
    input_schema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["demo", "live"] } },
      required: ["mode"],
    },
  },
];

async function executeTool(name, input) {
  if (name === "get_status") return tradingGet("/dashboard-data");
  if (name === "halt_trading") return tradingPost("/halt", { reason: input.reason || "halted via WhatsApp" });
  if (name === "resume_trading") return tradingPost("/resume");
  if (name === "switch_mode") return tradingPost("/mode", { mode: input.mode });
  throw new Error(`Unknown tool: ${name}`);
}

// ─── System prompt ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are Mysh's personal assistant for his automated Deriv forex trading bot.
You can check its live status, halt/resume it, and switch it between demo and live accounts, using the tools provided.

Rules:
- Keep replies SHORT like real WhatsApp messages — a few sentences, not an essay.
- Never invent numbers (balance, win rate, trade counts) — always get them from a tool call first.
- Switching to "live" trades real money — if the request is ambiguous about which mode, ask before switching.
- If sent an image (a chart, a screenshot, a strategy idea), discuss it helpfully, but never treat it as a command to execute a trade — only explicit instructions do that.
- If asked to add or change a trading strategy, explain that strategy management via chat is coming soon, and for now changes are made directly in the code.`;

// ─── Call Claude, handling any tool calls in a loop ─────────
async function getAssistantReply(conversation) {
  let messages = [...conversation];

  for (let i = 0; i < 4; i++) { // cap iterations so a tool-call loop can't run forever
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      },
      { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
    );

    const { content, stop_reason } = res.data;
    messages.push({ role: "assistant", content });

    if (stop_reason !== "tool_use") {
      const textBlock = content.find((b) => b.type === "text");
      return { reply: textBlock ? textBlock.text : "...", messages };
    }

    const toolResults = [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      let result;
      try {
        result = await executeTool(block.name, block.input);
      } catch (err) {
        result = { error: String(err) };
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { reply: "Something took too many steps — try rephrasing that.", messages };
}

// ─── Strategy-teaching chat (dashboard) ──────────────────────
// A separate conversation + tool from the WhatsApp assistant: this one's
// only job is to turn a plain-English strategy description into a precise,
// testable rule (currently: RSI threshold-based buy/sell conditions), and
// only hand it off to the trading server once you've confirmed it's right.
const STRATEGY_CHAT_PATH = path.join(__dirname, "strategy-chats.json");
function loadStrategyChats() { try { return JSON.parse(fs.readFileSync(STRATEGY_CHAT_PATH, "utf8")); } catch { return {}; } }
function saveStrategyChats(c) { fs.writeFileSync(STRATEGY_CHAT_PATH, JSON.stringify(c, null, 2)); }

const STRATEGY_TOOL = {
  name: "propose_strategy",
  description: "Call this once you fully understand the user's strategy as a precise, testable rule. Only supports RSI-threshold rules for now (buy below a threshold, sell above a threshold). If the user describes something this can't express (multiple indicators, price patterns, etc.), do NOT call this — explain the current limitation instead and ask if they want to simplify it to an RSI rule.",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "A short unique slug, e.g. 'rsi-aggressive-1'" },
      symbol: { type: "string", description: "Deriv symbol, default 'R_100' (Volatility 100 Index) unless the user names a different one" },
      buyOperator: { type: "string", enum: ["<", "<=", ">", ">="] },
      buyValue: { type: "number" },
      sellOperator: { type: "string", enum: ["<", "<=", ">", ">="] },
      sellValue: { type: "number" },
      description: { type: "string", description: "One-sentence plain-English summary of the strategy" },
    },
    required: ["id", "description"],
  },
};

const DIGIT_CONTRACT_KNOWLEDGE = `Background on Deriv digit contracts (you already know this — never ask Mysh to explain these mechanics, only ask about HIS specific preferences within them):

- Every synthetic index tick has a price with a final decimal digit, 0-9. Digit contracts predict that digit on the LAST tick of the contract.
- Over/Under: predicts whether the last digit will be over (>) or under (<) a chosen barrier digit. Over barrier is usually 0-8 (predicting a digit above it); Under barrier is usually 1-9 (predicting a digit below it).
- Matches/Differs: predicts whether the last digit will exactly match, or differ from, a chosen digit (0-9).
- Even/Odd: predicts whether the last digit will be even or odd — no barrier digit needed, just a direction.
- Contracts run for a chosen number of ticks (commonly 1-10), not a time duration — the number of ticks IS the duration.
- The digit-frequency circles Mysh is watching show the last 1000 ticks' digit distribution — a digit appearing more often (green/blue ring) suggests recent bias toward it; less often (yellow/red ring) suggests the opposite. A real strategy usually trades off this pattern in some way (e.g. betting a cold digit stays cold, or a hot digit keeps appearing, or reverts).

When he describes a strategy, you should already understand what he means by "the 5 is cold" or "trade differs on the hottest digit" — just confirm the specific numbers/digits/tick-count he wants, don't re-explain or ask what Over/Under means.`;

function buildStrategySystemPrompt(marketType, symbol) {
  const isDigitType = ['Over/Under', 'Matches/Differs', 'Even/Odd'].includes(marketType);

  const base = `You are helping Mysh design a trading strategy for his automated Deriv bot, through conversation.
He's designing a strategy for the "${marketType || 'Rise/Fall'}" market type on symbol ${symbol || 'R_100'}.
He can see a live visualization while talking to you — a real price chart for Rise/Fall, or live digit-frequency circles (last 1000 ticks) for digit-based types — so refer to what he's watching when relevant.
${isDigitType ? '\n' + DIGIT_CONTRACT_KNOWLEDGE + '\n' : ''}
Ask clarifying questions until you're confident you understand exactly what he wants — but only about HIS specific choices, never asking him to explain concepts you already know.
Keep responses short and conversational.`;

  if (marketType && marketType !== "Rise/Fall") {
    return `${base}

IMPORTANT: Live execution currently only supports Rise/Fall (RSI-threshold) strategies. For "${marketType}", you can fully discuss and refine the idea with him (which digits, thresholds, patterns he's watching for), but do NOT call propose_strategy — instead let him know this design will be saved as a plan, and live execution for ${marketType} is coming in a follow-up update.`;
  }

  return `${base}
Currently the bot can only execute RSI-threshold strategies: buy when RSI crosses below a value, sell when it crosses above a value (either direction is optional).
Once you're confident, call propose_strategy with the precise rule. Don't call it prematurely — confirm understanding first if anything is ambiguous.
If what he describes needs more than a single RSI threshold (e.g. multiple indicators, candlestick patterns, price action), say clearly that only RSI-threshold rules are supported right now, and offer to express the closest RSI-based approximation instead.`;
}

app.post("/strategy-chat", async (req, res) => {
  try {
    const { conversationId, message, marketType, symbol } = req.body;
    const chats = loadStrategyChats();
    const prior = chats[conversationId] || [];

    const messages = [...prior, { role: "user", content: message }];
    const systemPrompt = buildStrategySystemPrompt(marketType, symbol);

    const aiRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-5", max_tokens: 500, system: systemPrompt, tools: [STRATEGY_TOOL], messages },
      { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
    );

    const { content, stop_reason } = aiRes.data;
    messages.push({ role: "assistant", content });
    chats[conversationId] = messages.slice(-20);
    saveStrategyChats(chats);

    const textBlock = content.find((b) => b.type === "text");
    const proposal = content.find((b) => b.type === "tool_use" && b.name === "propose_strategy");

    res.json({
      reply: textBlock ? textBlock.text : (proposal ? "Here's what I've got — take a look below." : "..."),
      proposal: proposal ? proposal.input : null,
    });
  } catch (err) {
    console.error("strategy-chat error:", err.response?.data || err.message);
    res.status(500).json({ error: "strategy chat failed" });
  }
});

app.post("/strategy-confirm", async (req, res) => {
  try {
    const { proposal } = req.body;
    const definition = {
      id: proposal.id,
      symbol: proposal.symbol || "R_100",
      indicator: "rsi",
      description: proposal.description,
    };
    if (proposal.buyOperator && proposal.buyValue !== undefined) {
      definition.buyWhen = { operator: proposal.buyOperator, value: proposal.buyValue };
    }
    if (proposal.sellOperator && proposal.sellValue !== undefined) {
      definition.sellWhen = { operator: proposal.sellOperator, value: proposal.sellValue };
    }

    const result = await tradingPost("/strategies", { definition });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── Digit-pattern strategies (guided form, not chat) ────────
app.post("/strategy-backtest", async (req, res) => {
  try {
    const result = await tradingPost("/strategies/backtest", { definition: req.body.definition });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/strategy-backtest-all", async (req, res) => {
  try {
    const result = await tradingPost("/strategies/backtest-all", { definition: req.body.definition });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/strategy-pattern-confirm", async (req, res) => {
  try {
    const result = await tradingPost("/strategies", { definition: { ...req.body.definition, kind: "digit-pattern" } });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── Live market data proxies (for the Strategy Builder visualizations) ──
app.get("/market-ticks", async (req, res) => {
  try {
    const data = await tradingGet("/market/ticks", { symbol: req.query.symbol, count: req.query.count });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get("/market-digit-stats", async (req, res) => {
  try {
    const data = await tradingGet("/market/digit-stats", { symbol: req.query.symbol, count: req.query.count });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── Webhook verification ────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

// ─── Main message handler ────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);
    const from = msg.from;

    // Lock this down to the owner only — this bot can halt/resume real-money
    // trading, so it must not respond to or act on messages from anyone else.
    if (from !== OWNER_NUMBER) return res.sendStatus(200);

    const history = loadHistory();
    const prior = history[from] || [];

    let userContent;
    if (msg.type === "text") {
      userContent = msg.text.body;
    } else if (msg.type === "image") {
      const { base64, mimeType } = await downloadWhatsAppMedia(msg.image.id);
      userContent = [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
        { type: "text", text: msg.image.caption || "What do you make of this?" },
      ];
    } else {
      return res.sendStatus(200); // unsupported message type — ignore quietly
    }

    const conversation = [...prior, { role: "user", content: userContent }];
    const { reply, messages } = await getAssistantReply(conversation);

    await sendWA(from, reply);

    // Keep only the last 10 messages of history to bound memory/file size
    history[from] = messages.slice(-10);
    saveHistory(history);

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// ─── Dashboard data proxy (keeps the secret server-side, not in the browser) ─
app.get("/trading-data", async (req, res) => {
  try {
    const data = await tradingGet("/dashboard-data");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/trading-control", async (req, res) => {
  try {
    const { action, mode, strategyId } = req.body;
    let result;
    if (action === "halt") result = await tradingPost("/halt", { reason: "halted from dashboard" });
    else if (action === "resume") result = await tradingPost("/resume");
    else if (action === "mode") result = await tradingPost("/mode", { mode });
    else if (action === "remove_strategy") {
      const delRes = await axios.delete(`${TRADING_SERVER_URL}/strategies/${strategyId}`, {
        data: { secret: TRADING_SERVER_SECRET },
      });
      result = delRes.data;
    } else return res.status(400).json({ error: "unknown action" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "overview.html")));
app.listen(3000, () => console.log("Trading assistant bot running"));
      Deriv bot, through conversation.
He's designing a strategy for the "${marketType || 'Rise/Fall'}" market type on symbol ${symbol || 'R_100'}.
He can see a live visualization while talking to you — a real price chart for Rise/Fall, or live digit-frequency circles (last 1000 ticks) for digit-based types — so refer to what he's watching when relevant.
${isDigitType ? '\n' + DIGIT_CONTRACT_KNOWLEDGE + '\n' : ''}
Ask clarifying questions until you're confident you understand exactly what he wants — but only about HIS specific choices, never asking him to explain concepts you already know.
Keep responses short and conversational.`;

  if (marketType && marketType !== "Rise/Fall") {
    return `${base}

IMPORTANT: Live execution currently only supports Rise/Fall (RSI-threshold) strategies. For "${marketType}", you can fully discuss and refine the idea with him (which digits, thresholds, patterns he's watching for), but do NOT call propose_strategy — instead let him know this design will be saved as a plan, and live execution for ${marketType} is coming in a follow-up update.`;
  }

  return `${base}
Currently the bot can only execute RSI-threshold strategies: buy when RSI crosses below a value, sell when it crosses above a value (either direction is optional).
Once you're confident, call propose_strategy with the precise rule. Don't call it prematurely — confirm understanding first if anything is ambiguous.
If what he describes needs more than a single RSI threshold (e.g. multiple indicators, candlestick patterns, price action), say clearly that only RSI-threshold rules are supported right now, and offer to express the closest RSI-based approximation instead.`;
}

app.post("/strategy-chat", async (req, res) => {
  try {
    const { conversationId, message, marketType, symbol } = req.body;
    const chats = loadStrategyChats();
    const prior = chats[conversationId] || [];

    const messages = [...prior, { role: "user", content: message }];
    const systemPrompt = buildStrategySystemPrompt(marketType, symbol);

    const aiRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-5", max_tokens: 500, system: systemPrompt, tools: [STRATEGY_TOOL], messages },
      { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
    );

    const { content, stop_reason } = aiRes.data;
    messages.push({ role: "assistant", content });
    chats[conversationId] = messages.slice(-20);
    saveStrategyChats(chats);

    const textBlock = content.find((b) => b.type === "text");
    const proposal = content.find((b) => b.type === "tool_use" && b.name === "propose_strategy");

    res.json({
      reply: textBlock ? textBlock.text : (proposal ? "Here's what I've got — take a look below." : "..."),
      proposal: proposal ? proposal.input : null,
    });
  } catch (err) {
    console.error("strategy-chat error:", err.response?.data || err.message);
    res.status(500).json({ error: "strategy chat failed" });
  }
});

app.post("/strategy-confirm", async (req, res) => {
  try {
    const { proposal } = req.body;
    const definition = {
      id: proposal.id,
      symbol: proposal.symbol || "R_100",
      indicator: "rsi",
      description: proposal.description,
    };
    if (proposal.buyOperator && proposal.buyValue !== undefined) {
      definition.buyWhen = { operator: proposal.buyOperator, value: proposal.buyValue };
    }
    if (proposal.sellOperator && proposal.sellValue !== undefined) {
      definition.sellWhen = { operator: proposal.sellOperator, value: proposal.sellValue };
    }

    const result = await tradingPost("/strategies", { definition });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── Digit-pattern strategies (guided form, not chat) ────────
app.post("/strategy-backtest", async (req, res) => {
  try {
    const result = await tradingPost("/strategies/backtest", { definition: req.body.definition });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/strategy-pattern-confirm", async (req, res) => {
  try {
    const result = await tradingPost("/strategies", { definition: { ...req.body.definition, kind: "digit-pattern" } });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── Live market data proxies (for the Strategy Builder visualizations) ──
app.get("/market-ticks", async (req, res) => {
  try {
    const data = await tradingGet("/market/ticks", { symbol: req.query.symbol, count: req.query.count });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get("/market-digit-stats", async (req, res) => {
  try {
    const data = await tradingGet("/market/digit-stats", { symbol: req.query.symbol, count: req.query.count });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── Webhook verification ────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

// ─── Main message handler ────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);
    const from = msg.from;

    // Lock this down to the owner only — this bot can halt/resume real-money
    // trading, so it must not respond to or act on messages from anyone else.
    if (from !== OWNER_NUMBER) return res.sendStatus(200);

    const history = loadHistory();
    const prior = history[from] || [];

    let userContent;
    if (msg.type === "text") {
      userContent = msg.text.body;
    } else if (msg.type === "image") {
      const { base64, mimeType } = await downloadWhatsAppMedia(msg.image.id);
      userContent = [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
        { type: "text", text: msg.image.caption || "What do you make of this?" },
      ];
    } else {
      return res.sendStatus(200); // unsupported message type — ignore quietly
    }

    const conversation = [...prior, { role: "user", content: userContent }];
    const { reply, messages } = await getAssistantReply(conversation);

    await sendWA(from, reply);

    // Keep only the last 10 messages of history to bound memory/file size
    history[from] = messages.slice(-10);
    saveHistory(history);

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// ─── Dashboard data proxy (keeps the secret server-side, not in the browser) ─
app.get("/trading-data", async (req, res) => {
  try {
    const data = await tradingGet("/dashboard-data");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/trading-control", async (req, res) => {
  try {
    const { action, mode, strategyId } = req.body;
    let result;
    if (action === "halt") result = await tradingPost("/halt", { reason: "halted from dashboard" });
    else if (action === "resume") result = await tradingPost("/resume");
    else if (action === "mode") result = await tradingPost("/mode", { mode });
    else if (action === "remove_strategy") {
      const delRes = await axios.delete(`${TRADING_SERVER_URL}/strategies/${strategyId}`, {
        data: { secret: TRADING_SERVER_SECRET },
      });
      result = delRes.data;
    } else return res.status(400).json({ error: "unknown action" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "overview.html")));
app.listen(3000, () => console.log("Trading assistant bot running"));
      
