// api/index.js

import "dotenv/config";
import express from "express";
import cors from "cors";
import cheerio from "cheerio";
import { openai } from "../utils/openai.js";

const app = express();
app.use(express.json());

// ─── CORS CONFIG ─────────────────────────────────────────────────────────────
// Substitua pelos domínios exatos da sua loja Shopify e do seu site.
// Durante testes locais, pode também incluir "http://127.0.0.1:5500" ou "http://localhost:3000".
const allowedOrigins = [
  "https://a421cf-3c.myshopify.com",
  "https://behedone.com"
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Se estiver em Postman ou em file://, origin pode ser undefined
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

/** Função utilitária para aguardar um intervalo de tempo em milissegundos. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * chatWithAssistant
 * 1) Cria um thread se não existir
 * 2) Envia a mensagem do usuário para o thread
 * 3) Inicia o run do Assistente
 * 4) Se o run exigir a função get_shipping_policy, faz scrape e envia o resultado
 * 5) Faz polling até o run ficar "completed"
 * 6) Retorna a resposta final do Assistente e o threadId
 */
async function chatWithAssistant(userInput, threadId) {
  // 1) Criar thread se não existir
  if (!threadId) {
    const thread = await openai("threads", {});
    threadId = thread.id;
  }

  // 2) Adicionar mensagem do usuário
  await openai(`threads/${threadId}/messages`, {
    role: "user",
    content: userInput
  });

  // 3) Iniciar o run
  let run = await openai(`threads/${threadId}/runs`, {
    assistant_id: ASSISTANT_ID
  });

  // 4) Verificar se o modelo pediu a função get_shipping_policy
  if (
    run.status === "requires_action" &&
    run.required_action?.type === "submit_tool_outputs"
  ) {
    const call = run.required_action.submit_tool_outputs.tool_calls[0];

    if (call.function.name === "get_shipping_policy") {
      // 4.1) Fazer fetch ao HTML da página de política de envios
      const html = await fetch("https://behedone.com/policies/shipping-policy").then((res) =>
        res.text()
      );

      // 4.2) Extrair texto limpo usando Cheerio
      const $ = cheerio.load(html);
      let policy = "";
      const container = $(".rte");
      if (container.length) {
        policy = container.text().replace(/\s+/g, " ").trim();
      } else {
        policy = "Política de envios não encontrada.";
      }

      // 4.3) Enviar o resultado da função de volta à OpenAI
      await openai(`threads/${threadId}/runs/${run.id}/submit_tool_outputs`, {
        tool_outputs: [
          {
            tool_call_id: call.id,
            output: policy
          }
        ]
      });

      // 4.4) Recuperar o run atualizado
      const updatedRunRes = await fetch(
        `https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`,
        { headers: HEADERS }
      );
      run = await updatedRunRes.json();
    }
  }

  // 5) Polling até o run ficar "completed" ou falhar
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

  // 6) Buscar a última mensagem do Assistente
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
