export async function openai(endpoint, { method = "POST", payload = null } = {}) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":  "application/json",
      "OpenAI-Beta":   "assistants=v2"
    }
  };

  // Só inclui body se houver payload e for POST/PATCH
  if (payload && method !== "GET") opts.body = JSON.stringify(payload);

  const res = await fetch(`https://api.openai.com/v1/${endpoint}`, opts);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${method} ${endpoint} → ${res.status}: ${err}`);
  }
  return res.json();      // sempre devolve JSON
}
