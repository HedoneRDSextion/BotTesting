// api/index.js – versão simplificada (ajustada para threadId)

import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

/*────────────────── Configuração ──────────────────*/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app    = express();
app.use(express.json());

// CORS: permita apenas domínios da loja
const ALLOWED = [
  "https://a421cf-3c.myshopify.com",
  "https://behedone.com"
];
app.use(cors({
  origin: (o, cb) => (!o || ALLOWED.includes(o)) ? cb(null, true) : cb(new Error("CORS")),
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

/*────────────────── Utilitários ───────────────────*/
const wait = ms => new Promise(r => setTimeout(r, ms));
const webSearch = async (url, term) => (await openai.responses.create({
  model : "gpt-4.1",
  tools : [{ type: "web_search_preview" }],
  input : `site:${url} "${term}" HEDØNE`
})).output_text;

/*────────────────── Fluxo principal ───────────────*/
async function talk(userInput, threadId = null) {
  // 1️⃣ cria thread se não existir
  if (!threadId) threadId = (await openai.threads.create()).id;

  // 2️⃣ adiciona mensagem do utilizador
  await openai.threads.messages.create(threadId, {
    role: "user",
    content: userInput
  });

  // 3️⃣ inicia o run
  let run = await openai.threads.runs.create(threadId, {
    assistant_id: process.env.ASSISTANT_ID
  });

  // 4️⃣ se o modelo pedir função externa
  if (run.status === "requires_action" && run.required_action?.type === "call_function") {
    const call = run.required_action.call_function;
    let output = "Função desconhecida";

    if (call.function.name === "get_shipping_policy")
      output = await webSearch("behedone.com/policies/shipping-policy","shipping policy");

    if (call.function.name === "get_refund_policy")
      output = await webSearch("behedone.com/policies/refund-policy","refund policy");

    await openai.threads.runs.submitToolOutputs(threadId, run.id, [
      { tool_call_id: call.id, output }
    ]);

    run = await openai.threads.runs.retrieve(threadId, run.id);
  }

  // 5️⃣ aguarda conclusão
  while (["queued","in_progress"].includes(run.status)) {
    await wait(800);
    run = await openai.threads.runs.retrieve(threadId, run.id);
  }
  if (run.status !== "completed") throw new Error(`Run falhou: ${run.status}`);

  // 6️⃣ devolve a última mensagem do assistente
  const { data } = await openai.threads.messages.list(threadId, { limit: 1, order: "desc" });
  return { reply: data[0].content[0].text.value, threadId };
}

/*────────────────── Endpoint REST ─────────────────*/
app.post("/api/chat", async (req, res) => {
  const userInput = req.body.userInput?.trim();
  const threadId  = req.body.threadId ?? null;      // garante null (não undefined)

  if (!userInput) return res.status(400).json({ error: "userInput é obrigatório" });
  try {
    const { reply, threadId: newTid } = await talk(userInput, threadId);
    res.json({ reply, threadId: newTid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default app;
