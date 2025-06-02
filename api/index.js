import "dotenv/config";
import express from "express";
import cors from "cors";
import { openai } from "../utils/openai.js";
import cheerio from "cheerio";

const app = express();
app.use(express.json());
app.use(cors({ origin: ["https://a421cf-3c.myshopify.com", "https://behedone.com"] }));

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

  if (status === "requires_action" &&
    run.required_action?.type === "submit_tool_outputs"
  )
  {
    const call = run.required_action.submit_tool_outputs.tool_calls[0];

    if (call.function.name === "get_shipping_policy") {
      /* faz scraping */
      const policy = await fetch("https://behedone.com/policies/shipping-policy")
        .then(r => r.text())

        // 2. extrair o texto com cheerio
      const $ = cheerio.load(html);
      let policyAux = "";
      const container = $(".rte");
      if (container.length) {
        policyAux = container.text().replace(/\s+/g, " ").trim();
      } else {
        policyAux = "Política de envios não encontrada.";
      }

      /* envia o resultado da tool */
      await openai(`threads/${threadId}/runs/${run.id}/submit_tool_outputs`, {
        tool_outputs: [{
          tool_call_id: call.id,
          output: policyAux
        }]
      }, "POST");

      // 4. refrescar o estado do run antes de continuar
      const after = await openai(`threads/${threadId}/runs/${run.id}`, {}, "GET");
      run.status = after.status;
    }

      /* depois faz polling até status === completed (como antes) */
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
