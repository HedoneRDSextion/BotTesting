// api/index.js

import "dotenv/config";
import express from "express";
import cors from "cors";

import { openai } from "../utils/openai.js";

const app = express();
app.use(express.json());

// ─── CORS CONFIG ─────────────────────────────────────────────────────────────
// Permitir apenas domínios autorizados (Shopify e behedone.com). Adicione locais de teste conforme necessário.
const allowedOrigins = [
  "https://a421cf-3c.myshopify.com",  // substitua pelo domínio da loja
  "https://behedone.com"
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Não permitido pelo CORS: " + origin), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);
// ───────────────────────────────────────────────────────────────────────────────

const { ASSISTANT_ID, OPENAI_API_KEY } = process.env;
const HEADERS = {
  "Authorization": `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2"
};

/**
 * Função utilitária para aguardar um intervalo de tempo em milissegundos.
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * getShippingPolicyViaSearch
 * Usa o Responses API com o web_search_preview tool para obter a política de envios em tempo real.
 */
async function getShippingPolicyViaSearch() {
  const payload = {
    model: "gpt-4o-mini",
    tools: [{ type: "web_search_preview" }],
    input: "site:https://behedone.com/policies/shipping-policy \"shipping policy\" HEDØNE"
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI Responses API error: ${err}`);
  }
  const data = await res.json();
  // O output_text contém o texto sintetizado da política de envios
  return data.output_text;
}

/**
 * chatWithAssistant
 * Fluxo de conversa geral usando Assistants API + retrieval.
 * Se detectar intenção de policy, usa getShippingPolicyViaSearch.
 */
async function chatWithAssistant(userInput, threadId) {
  // Se a mensagem do usuário indicar consulta sobre envio, responde imediatamente
  if (userInput.toLowerCase().includes("envio")) {
    try {
      const policyText = await getShippingPolicyViaSearch();
      return { reply: policyText, threadId };
    } catch (err) {
      console.error("Erro ao buscar policy via Web Search:", err);
      // fallback genérico
      return { reply: "Desculpe, não consegui obter a política de envios no momento.", threadId };
    }
  }

  // 1) Criar thread se não existir
  if (!threadId) {
    const thread = await openai("threads", {});
    threadId = thread.id;
  }

  // 2) Adicionar mensagem do usuário ao thread
  await openai(`threads/${threadId}/messages`, {
    role: "user",
    content: userInput
  });

  // 3) Iniciar o run
  let run = await openai(`threads/${threadId}/runs`, {
    assistant_id: ASSISTANT_ID
  });

  // 4) Polling até o run ficar completed/failed
  let status = run.status;
  while (status === "queued" || status === "in_progress") {
    await wait(1000);
    const checkRes = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`,
      { headers: HEADERS }
    );
    const check = await checkRes.json();
    status = check.status;
  }

  if (status !== "completed") {
    throw new Error(`Run terminou em estado "${status}"`);
  }

  // 5) Obter a última mensagem do assistente
  const msgsRes = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/messages?limit=1&order=desc`,
    { headers: HEADERS }
  );
  const msgs = await msgsRes.json();
  const reply = msgs.data[0]?.content[0]?.text?.value || "(sem resposta)";

  return { reply, threadId };
}

// Rota consumida pelo front-end / widget Shopify
app.post("/api/chat", async (req, res) => {
  try {
    const { userInput, threadId } = req.body;
    if (!userInput) {
      return res.status(400).json({ error: "userInput é obrigatório" });
    }
    const { reply, threadId: newThreadId } = await chatWithAssistant(
      userInput,
      threadId
    );
    res.json({ reply, threadId: newThreadId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Exporta o app para o Vercel (não usar app.listen)
export default app;
