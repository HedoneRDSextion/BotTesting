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
 * 1) Cria thread se não existir
 * 2) Envia mensagem do utilizador (com “role” e “content” dentro de payload)
 * 3) Cria um run (com “assistant_id” dentro de payload)
 * 4) Polling até run sair de “queued”/“in_progress”
 * 5) Se run exigir chamada de função:
 *      → Extrai parâmetros de call.required_action.call_function.function.parameters
 *      → Invoca getShippingPolicyViaSearch(user_query) ou getRefundPolicyViaSearch(user_question)
 *      → Envia o resultado com submit_tool_outputs (envolvendo tool_outputs dentro de payload)
 *      → Polling até run.status === “completed”
 * 6) Retorna a última resposta do assistente
 */
async function chatWithAssistant(userInput, threadId) {
  // 1) Se não houver thread, cria uma nova
  if (!threadId) {
    const threadResp = await openai("threads"); // sem payload → POST sem body
    threadId = threadResp.id;
  }

  // 2) Envia a mensagem do utilizador
  await openai(
    `threads/${threadId}/messages`,
    {
      payload: {
        role: "user",
        content: userInput
      }
    }
  );

  // 3) Inicia um run
  let run = await openai(
    `threads/${threadId}/runs`,
    {
      payload: { assistant_id: ASSISTANT_ID }
    }
  );

  // 4) Polling até sair de “queued” ou “in_progress”
  while (["queued", "in_progress"].includes(run.status)) {
    await wait(800);
    run = await openai(
      `threads/${threadId}/runs/${run.id}`,
      { method: "GET" }
    );
  }

  // 5) Se o assistant pediu para chamar uma função
  if (run.status === "requires_action" && run.required_action?.type === "call_function") {
    const call = run.required_action.call_function;
    let output = "Função desconhecida";

    if (call.function.name === "get_shipping_policy") {
      // Extrai inquiry_type e user_query dos parâmetros
      const { inquiry_type, user_query } = call.function.parameters;
      // Invoca a search local usando apenas user_query (conforme a função já existente)
      output = await getShippingPolicyViaSearch(user_query);
    }

    if (call.function.name === "get_refund_policy") {
      // Extrai user_question dos parâmetros
      const { user_question } = call.function.parameters;
      // Invoca a search local usando user_question
      output = await getRefundPolicyViaSearch(user_question);
    }

    // 5-B) Envia o resultado da função de volta ao run, via submit_tool_outputs
    await openai(
      `threads/${threadId}/runs/${run.id}/submit_tool_outputs`,
      {
        payload: {
          tool_outputs: [
            {
              tool_call_id: call.id,
              output
            }
          ]
        }
      }
    );

    // 5-C) Polling de novo até run.status === "completed"
    do {
      await wait(800);
      run = await openai(
        `threads/${threadId}/runs/${run.id}`,
        { method: "GET" }
      );
    } while (["queued", "in_progress"].includes(run.status));
  }

  if (run.status !== "completed") {
    throw new Error(`Run terminou em estado ${run.status}`);
  }

  // 6) Busca a última mensagem do assistente
  const messagesResp = await openai(
    `threads/${threadId}/messages?limit=1&order=desc`,
    { method: "GET" }
  );
  const reply = messagesResp.data[0].content[0].text.value;

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
