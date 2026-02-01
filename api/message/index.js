async function callAzureOpenAI({ notes, questionNumber, userAnswer }) {
  const endpoint = requireEnv("AZURE_OPENAI_ENDPOINT").replace(/\/+$/, "");
  const apiKey = requireEnv("AZURE_OPENAI_KEY");

  // Foundry Models v1 endpoint (works with the newer UI/deployments)
  const url = `${endpoint}/openai/v1/chat/completions`;

  const system = [
    "You are playing 20 Questions.",
    "Ask exactly ONE yes/no question at a time to guess the user's secret object.",
    "Output MUST be only the question text (no extra words).",
    "Keep it short. Don't repeat previous questions.",
    "If confident, ask: 'Is it <your guess>?'",
    "Max 20 questions."
  ].join("\n");

  const user = [
    `We are on question ${questionNumber}/20.`,
    `User just answered: ${userAnswer || "(none yet)"}`,
    `Notes so far (compressed memory): ${notes || "(none)"}`,
    "Ask the next best yes/no question."
  ].join("\n");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify({
      // In v1, "model" is the model name. Your deployment uses gpt-4.1-nano.
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.4,
      max_tokens: 60
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Azure OpenAI error ${res.status}: ${t}`);
  }

  const data = await res.json();
  const text =
    data?.choices?.[0]?.message?.content?.trim() ||
    "Is it something you can hold in one hand?";

  return text.endsWith("?") ? text : `${text}?`;
}
