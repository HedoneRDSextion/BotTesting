// api/index.js

import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const openai = new OpenAI();
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


async function ensureAssistantExists() {

    // If we already fetched or created it, skip.
    if (ASSISTANT_ID) return;

    // Validate if our assistant exists
    const existAss = await openai.beta.assistants.retrive(ASSISTANT_ID);

    if (existAss) {
      return;
    } else {
        throw new Error(`The "${ASSISTANT_ID}" does not currently exists`);
    }
}


async function retrieveThread(threadId){
    try{
        const myThread = await openai.beta.threads.retrieve(
            threadId
        )
        return myThread.id
    }catch(err){
        return null;
    }

}

/**
 * 4. MAIN HANDLER: Receives a user message, forwards to the Assistants API, returns AI reply.
 *    Expects JSON body: {
 *                        userId: string,
 *                        message: string,
 *                        threadId?: string
*                        }
 *    Returns: { reply: string, threadId: string }
 */

async function chatWithAssistant(userInput, threadId) {

}


app.post("/api/chat", async (req, res) => {
    const newThread = "";
    try{
        const { userId, userInput, threadId } = req.body;
        if (!userInput || !userId){
            return res.status(400).json({error: "User input and user ID are mandatory"});
        }

        //before starting a conversation it must validate the existance of an assistant
        await ensureAssistantExists();

        let activeThread = await retrieveThread(threadId)

        if(!activeThread){
            newThread = await openai.beta.threads.create();
        }else{
            newThread = activeThread
        }

        const threadMessages = await openai.beta.threads.messages.create(
            newThread,
            {
                role: "user",
                content: userInput
            }
        );

        const runAssistant = await openai.beta.threads.runs.create(
            newThread,
            { assistant_id: ASSISTANT_ID }
        );

        // 4d. Extract the assistant’s reply
        const aiReply = runAssistant.choices[0].message.content.trim();

        // 4e. Return AI reply and threadId so client can continue the conversation
        return res.json({
            reply: aiReply,
            threadId: newThread,
        });


    }catch (error) {
        console.error("Error in /assistant-chat:", error);
        return res.status(500).json({
          error: "An error occurred while communicating with the Assistants API.",
          details: error.message,
        });
    }
})

export default app;