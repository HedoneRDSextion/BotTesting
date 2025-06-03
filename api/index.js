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
 * 2) Envia user message
 * 3) Inicia run
 * 4) Se run.required_action.type === "call_function":
 *      → determina qual função chamar pelo run.required_action.call_function.name
 *      → executa a função local (ex.: getShippingPolicyViaSearch)
 *      → envia o resultado com submit_tool_outputs
 *      → faz um GET para buscar o run atualizado
 * 5) Polling padrão até run.status === "completed"
 * 6) Lê a última mensagem do assistente e retorna { reply, threadId }
 */
async function chatWithAssistant(userInput, threadId) {

  // 1) Criar thread
  if (!threadId) {
    const thread = await openai("threads", {});
    threadId = thread.id;
  }

  // 2) Adicionar mensagem do usuário
  await openai(`threads/${threadId}/messages`, {
    role: "user",
    content: userInput
  });

  // 3) Iniciar run
  let run = await openai(`threads/${threadId}/runs`, {
    assistant_id: ASSISTANT_ID
  });

  // 4) Verifica se é necessário chamar função
  if (
    run.status === "requires_action" &&
    run.required_action?.type === "call_function"
  ) {
    const call = run.required_action.call_function;
    let funcOutput;

    console.log(call)

    // 4.1) Qual função chamar?
    if (call.function.name === "get_shipping_policy") {
      // se a Assistant gerar um call_function "get_shipping_policy"
      funcOutput = await getShippingPolicyViaSearch(userInput);

    } else if (call.function.name === "get_refund_policy") {
      // se ela gerar "get_refund_policy"
      funcOutput = await getRefundPolicyViaSearch(userInput);

    } else {
      // Se for outra função que você não espera, pode fazer fallback ou erro:
      funcOutput = `Função desconhecida: ${call.function.name}`;
    }

    // 4.2) Envia o resultado da função de volta ao Assistant
    await openai(
      `threads/${threadId}/runs/${run.id}/submit_tool_outputs`,
      {
        tool_outputs: [
          {
            tool_call_id: call.id,
            output: funcOutput
          }
        ]
      }
    );

    // 4.3) Ler o run atualizado (GET sem body)
    const updatedRunRes = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`,
      { headers: HEADERS }
    );
    run = await updatedRunRes.json();
  }

  // 5) Polling até run.status === "completed"
  let status = run.status;
  while (status === "queued" || status === "in_progress") {
    await wait(100);
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

  // 6) Obter a última mensagem do Assistente
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

export default app;
