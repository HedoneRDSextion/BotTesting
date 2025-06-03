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
  /* 1. cria thread se necessário */
  if (!threadId) threadId = (await openai("threads", {})).id;

  /* 2. adiciona mensagem do utilizador */
  await openai(`threads/${threadId}/messages`, { role: "user", content: userInput });

  /* 3. inicia o run */
  let run = await openai(`threads/${threadId}/runs`, { assistant_id: ASSISTANT_ID });

  /* 3-B.  >>>  POLLING  <<<  */
  while (["queued", "in_progress"].includes(run.status)) {
    await wait(800)
    run = await openai(`threads/${threadId}/runs/${run.id}`, { method: "GET" });
  }
  console.log("run.status final:", run.status);          // debug

  /* 4. se precisar de função externa */
  if (run.status === "requires_action" && run.required_action?.type === "call_function") {
    const call = run.required_action.call_function;
    let output = "Função desconhecida";

    if (call.function.name === "get_shipping_policy")
      output = await getShippingPolicyViaSearch(userInput);

    if (call.function.name === "get_refund_policy")
      output = await getRefundPolicyViaSearch(userInput);

    /* 4-B. submete o resultado da função */
    await openai(
      `threads/${threadId}/runs/${run.id}/submit_tool_outputs`,
      { tool_outputs: [{ tool_call_id: call.id, output }] }
    );

    /* 4-C. espera o run concluir com a resposta final */
    do {
      await wait(800);
      run = await openai(`threads/${threadId}/runs/${run.id}`, { method: "GET" });
    } while (["queued", "in_progress"].includes(run.status));
  }

  if (run.status !== "completed")
    throw new Error(`Run terminou em estado ${run.status}`);

  /* 5. busca a última mensagem do assistente */
  const { data } = await openai(`threads/${threadId}/messages?limit=1&order=desc`, { method: "GET" });
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
