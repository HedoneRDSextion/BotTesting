import "dotenv/config";
import express from "express";
import cors from "cors";
import { openai } from "../utils/openai.js";
import cheerio from "cheerio";

const app = express();
app.use(express.json());
app.use(cors({ origin: ["https://a421cf-3c.myshopify.com", "https://behedone.com"] }));

const { ASSISTANT_ID, OPENAI_API_KEY } = process.env;
const HEADERS = {
  "Authorization": `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2"
};

/** Função utilitária para aguardar N milissegundos. */
const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Conduz toda a conversa com o Assistente:
 * 1) Cria thread (se não existir)
 * 2) Adiciona mensagem do user
 * 3) Inicia o run
 * 4) Se o run pedir a função get_shipping_policy, executa o scrape e envia o resultado
 * 5) Faz polling até o run ficar `completed`
 * 6) Retorna a última resposta do assistente + threadId
 */
async function chatWithAssistant(userInput, threadId) {
  // 1) Criar thread se não existir
  if (!threadId) {
    const thread = await openai("threads", {}); // POST /v1/threads
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

  // 4) Se o modelo pediu a função get_shipping_policy, executa-a antes de continuar
  if (
    run.status === "requires_action" &&
    run.required_action?.type === "submit_tool_outputs"
  ) {
    const call = run.required_action.submit_tool_outputs.tool_calls[0];

    if (call.function.name === "get_shipping_policy") {
      // 4.1) Buscar o HTML da página de envio
      const html = await fetch("https://behedone.com/policies/shipping-policy").then(r =>
        r.text()
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

      // 4.4) Recuperar o run atualizado (GET sem body)
      const updatedRunRes = await fetch(
        `https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`,
        { headers: HEADERS }
      );
      run = await updatedRunRes.json();
    }
  }

  // 5) Polling até status = "completed" (ou falhar)
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

  // 6) Buscar a última mensagem do assistente
  const msgsRes = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/messages?limit=1&order=desc`,
    { headers: HEADERS }
  );
  const msgs = await msgsRes.json();
  const reply = msgs.data[0]?.content[0]?.text?.value || "(sem resposta)";

  return { reply, threadId };
}

// Rota que o widget/Front-end irá chamar
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

// **Não** precisa do app.listen() aqui: o Vercel expõe automaticamente
export default app;