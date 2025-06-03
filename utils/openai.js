import OpenAI from "openai";

const openai = new OpenAI()

export async function openai(endpoint, payload) {
  const res = await fetch(`https://api.openai.com/v1/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${err}`);
  }
  return res.json();
}
