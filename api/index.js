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
 * e lida corretamente com o estado “requires_action” de tipo “submit_tool_outputs”.
 *
 * ATENÇÃO: TODAS as chamadas POST têm de enviar o JSON dentro da chave `payload`,
 *          porque o helper openai.js só converte `payload` em corpo da request.
 */
async function chatWithAssistant(userInput, threadId) {
  // 1) Se não houver thread, cria uma nova
  if (!threadId) {
    const threadRes = await openai("threads", {}); // POST /threads (sem body)
    threadId = threadRes.id;
  }

  // 2) Adiciona a mensagem do utilizador ao thread
  await openai(
    `threads/${threadId}/messages`,
    {
      payload: {
        role: "user",
        content: userInput
      }
    }
  );

  // 3) Cria um run para esse thread, indicando o assistant_id
  let run = await openai(
    `threads/${threadId}/runs`,
    {
      payload: {
        assistant_id: ASSISTANT_ID
      }
    }
  );

  // 3-B) Polling até o run passar de queued/in_progress
  while (["queued", "in_progress"].includes(run.status)) {
    await wait(800);
    run = await openai(
      `threads/${threadId}/runs/${run.id}`,
      { method: "GET" }
    );
  }

  // 4) Se a API disser requires_action e o tipo for submit_tool_outputs,
  //    é porque o assistant decidiu chamar uma função
  if (
    run.status === "requires_action" &&
    run.required_action?.type === "submit_tool_outputs"
  ) {
    // 4-A) Extrair o primeiro tool_call
    const toolCall = run.required_action
      .submit_tool_outputs.tool_calls[0];
    const functionName = toolCall.function.name;
    // Os arguments vêm como string JSON
    const parameters = JSON.parse(toolCall.function.arguments);

    let output = "Função não tratada";

    // 4-B) Dependendo do nome, invoca a função local
    if (functionName === "get_shipping_policy") {
      // Esperamos que parameters tenha { inquiry_type, user_query }
      const { inquiry_type, user_query } = parameters;
      output = await getShippingPolicyViaSearch(user_query);
    }

    if (functionName === "get_refund_policy") {
      // Esperamos que parameters tenha { user_question }
      const { user_question } = parameters;
      output = await getRefundPolicyViaSearch(user_question);
    }

    // 4-C) Envia o resultado da função de volta ao run
    await openai(
      `threads/${threadId}/runs/${run.id}/submit_tool_outputs`,
      {
        payload: {
          tool_outputs: [
            {
              tool_call_id: toolCall.id,
              output
            }
          ]
        }
      }
    );

    // 4-D) Polling de novo até o run ficar “completed”
    do {
      await wait(800);
      run = await openai(
        `threads/${threadId}/runs/${run.id}`,
        { method: "GET" }
      );
    } while (["queued", "in_progress"].includes(run.status));
  }

  // 5) Se não ficou completed, deu erro
  if (run.status !== "completed") {
    throw new Error(`Run terminou em estado ${run.status}`);
  }

  // 6) Finalmente, lê a última mensagem do assistant
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
