// api/index.js – versão simplificada

import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

/*────────────────────── Config. Básica ──────────────────────*/
const openai = new OpenAI();
const app    = express();
app.use(express.json());

// CORS – só permite Shopify + domínio da loja
const ALLOWED = [
  "https://a421cf-3c.myshopify.com",
  "https://behedone.com"
];
app.use(cors({
  origin: (o, cb) => (!o || ALLOWED.includes(o)) ? cb(null, true)
                                           : cb(new Error("CORS")),
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

/*────────────────────── Helpers ─────────────────────────────*/
const wait = ms => new Promise(r => setTimeout(r, ms));
const HEAD = {
  "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
  "Content-Type" : "application/json",
  "OpenAI-Beta"  : "assistants=v2"
};

// Web‑search helpers (Responses API)
const webSearch = async (url, term, userInput) => {
  const { output_text } = await openai.responses.create({
    model : "gpt-4.1",
    tools : [{ type: "web_search_preview" }],
    input : `site:${url} "${term}" HEDØNE` + userInput
  });
  return output_text;
};

/*────────────────────── Função principal ───────────────────*/
async function talk(userInput, threadId) {
  // Cria thread, se necessário
  if (!threadId) threadId = (await openai.beta.threads.create()).id;

  // Envia msg do user
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: userInput
  });

  // Inicia o run
  let run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: process.env.ASSISTANT_ID
  });

  // Se o modelo pedir função externa
  if (run.status === "requires_action") {
    const { call_function: call } = run.required_action;
    let output = "Função desconhecida";

    if (call.function.name === "get_shipping_policy")
      output = await webSearch(
        "behedone.com/policies/shipping-policy",
        "shipping policy",
        userInput
      );

    if (call.function.name === "get_refund_policy")
      output = await webSearch(
        "behedone.com/policies/refund-policy",
        "refund policy",
        userInput
      );

    // devolve resultado da função
    await openai.beta.threads.runs.submitToolOutputs(
      threadId,
      run.id,
      [{ tool_call_id: call.id, output }]
    );

    // actualiza o run
    run = await openai.beta.threads.runs.retrieve(threadId, run.id);
  }

  // Espera até concluir
  while (["queued", "in_progress"].includes(run.status)) {
    await wait(800);
    run = await openai.beta.threads.runs.retrieve(threadId, run.id);
  }

  if (run.status !== "completed") throw new Error("Run falhou");

  // Resposta final
  const { data } = await openai.beta.threads.messages.list(threadId, { limit: 1, order: "desc" });
  return { reply: data[0].content[0].text.value, threadId };
}

/*────────────────────── Endpoint ───────────────────────────*/
app.post("/api/chat", async (req, res) => {
  try {
    const { userInput, threadId } = req.body;
    if (!userInput) return res.status(400).json({ error: "userInput é obrigatório" });

    const { reply, threadId: tId } = await talk(userInput, threadId);
    res.json({ reply, threadId: tId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default app;
