// api/index.js

import "dotenv/config";
import express from "express";
import cors from "cors";
import { openai } from "../utils/openai.js";
import OpenAI from "openai";

const ofOpenAI = new OpenAI();
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
async function getShippingPolicyViaSearch(userInput) {

  const response = await ofOpenAI.responses.create({
    model: "gpt-4.1",
    tools: [{
      type: "web_search_preview",
    }],
    input: "site:https://behedone.com/policies/shipping-policy \"shipping policy\" HEDØNE; user-input: " + userInput
  })

  return response.output_text;
}


/**
 * getShippingPolicyViaSearch
 * Usa o Responses API com o web_search_preview tool para obter a política de envios em tempo real.
 */
async function getRefundPolicyViaSearch(userInput) {

  const response = await ofOpenAI.responses.create({
    model: "gpt-4.1",
    tools: [{
      type: "web_search_preview",
    }],
    input: "site:https://behedone.com/policies/refund-policy \"refund policy\" HEDØNE; user-input: " + userInput
  })

  return response.output_text;
}

/**
 * chatWithAssistant
 * Envia uma mensagem do utilizador a um Assistant na API da OpenAI
 * e lida com eventuais chamadas a funções (“call_function”).
 *
 * ⚠️  Atenção: TODAS as chamadas POST têm de enviar o JSON dentro da chave `payload`,
 *              porque o helper openai.js só converte `payload` em corpo da request.
 */
async function chatWithAssistant(userInput, threadId) {
  // 1) Criar um thread se ainda não existir
  if (!threadId) {
    const threadRes = await openai("threads", {}); // POST /threads (sem body)
    threadId = threadRes.id;
  }

  // 2) Adicionar a mensagem do utilizador
  await openai(
    `threads/${threadId}/messages`,
    {
      payload: { role: "user", content: userInput } // 👈 obrigatório
    }
  );

  // 3) Iniciar o run
  let run = await openai(
    `threads/${threadId}/runs`,
    {
      payload: { assistant_id: ASSISTANT_ID } // 👈 obrigatório
    }
  );

  // 3-B) Polling até o status deixar de ser queued/in_progress
  while (["queued", "in_progress"].includes(run.status)) {
    await wait(800);
    run = await openai(
      `threads/${threadId}/runs/${run.id}`,
      { method: "GET" }
    );
  }

  // 4) Se o assistant pediu uma função
  if (run.status === "requires_action" &&
      run.required_action?.type === "call_function") {

    const call = run.required_action.call_function;
    let output = "Função não tratada";

    /* --- get_shipping_policy --- */
    if (call.name === "get_shipping_policy") {
      const { inquiry_type, user_query } = call.parameters;
      output = await getShippingPolicyViaSearch(user_query);
      // (pode usar inquiry_type para afinar a query)
    }

    /* --- get_refund_policy --- */
    if (call.name === "get_refund_policy") {
      const { user_question } = call.parameters;
      output = await getRefundPolicyViaSearch(user_question);
    }

    // 4-B) Entregar o resultado da função ao Assistant
    await openai(
      `threads/${threadId}/runs/${run.id}/submit_tool_outputs`,
      {
        payload: {
          tool_outputs: [{
            tool_call_id: call.id,
            output
          }]
        }
      }
    );

    // 4-C) Polling outra vez até o run ficar completed
    do {
      await wait(800);
      run = await openai(
        `threads/${threadId}/runs/${run.id}`,
        { method: "GET" }
      );
    } while (["queued", "in_progress"].includes(run.status));
  }

  // 5) Se não concluiu, algo falhou
  if (run.status !== "completed") {
    throw new Error(`Run terminou no estado ${run.status}`);
  }

  // 6) Buscar a última mensagem do assistant
  const { data } = await openai(
    `threads/${threadId}/messages?limit=1&order=desc`,
    { method: "GET" }
  );
  const reply = data[0].content[0].text.value;

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

export default app;
