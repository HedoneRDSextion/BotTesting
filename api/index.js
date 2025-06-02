import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";          // para as chamadas manuais de polling
import { openai } from "./utils/openai.js";

const app = express();
app.use(express.json());
app.use(cors({ origin: ["https://a421cf-3c.myshopify.com"] }));

const { ASSISTANT_ID, OPENAI_API_KEY } = process.env;

/* delay simples */
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ===== Função principal de conversa ===== */
async function chatWithAssistant(userInput, threadId) {
  /* 1. Cria thread se necessário */
  if (!threadId) {
    const thread = await openai("threads", {});
    threadId = thread.id;
  }

  /* 2. Adiciona mensagem do user */
  await openai(`threads/${threadId}/messages`, {
    role: "user",
    content: userInput
  });

  /* 3. Lança o run */
  const run = await openai(`threads/${threadId}/runs`, {
    assistant_id: ASSISTANT_ID
  });
  let status = run.status;

  /* 4. Polling até concluir */
  while (status === "queued" || status === "in_progress") {
    await wait(1000);
    const check = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        }
      }
    ).then(r => r.json());
    status = check.status;
  }

  if (status !== "completed") throw new Error(`Run terminou em ${status}`);

  /* 5. Vai buscar a última msg do assistente */
  const msgs = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/messages?limit=1&order=desc`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      }
    }
  ).then(r => r.json());

  const reply = msgs.data[0]?.content[0]?.text?.value || "(sem resposta)";
  return { reply, threadId };
}

/* ===== Endpoint consumido pelo widget ===== */
app.post("/api/chat", async (req, res) => {
  try {
    const { userInput, threadId } = req.body;
    if (!userInput) return res.status(400).json({ error: "userInput obrigatório" });

    const { reply, threadId: newThread } = await chatWithAssistant(userInput, threadId);
    res.json({ reply, threadId: newThread });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🟢  API pronta em http://localhost:${PORT}`));
