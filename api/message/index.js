const { TableClient } = require("@azure/data-tables");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function callAzureOpenAI({ notes, questionNumber, userAnswer }) {
  const endpoint = requireEnv("AZURE_OPENAI_ENDPOINT").replace(/\/+$/, "");
  const apiKey = requireEnv("AZURE_OPENAI_KEY");
  const deployment = requireEnv("AZURE_OPENAI_DEPLOYMENT");

  // Azure OpenAI chat completions endpoint (works for GPT-4.1-nano deployments too)
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`;

  const system = [
    "You are playing 20 Questions.",
    "Your job: ask exactly ONE yes/no question at a time to guess the user's secret object.",
    "Rules:",
    "- Output MUST be only the question text (no quotes, no bullets, no extra words).",
    "- Keep it short.",
    "- Do not repeat a previous question.",
    "- If you are confident you can guess, ask: 'Is it <your guess>?'",
    "- Max 20 questions total."
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

  // Very light guardrail: ensure it ends with a question mark
  return text.endsWith("?") ? text : `${text}?`;
}

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const sessionId = body.sessionId;
    const userAnswer = (body.userAnswer || "").toString().trim();

    if (!sessionId) {
      context.res = { status: 400, body: { text: "Missing sessionId." } };
      return;
    }

    const storageConn = requireEnv("STORAGE_CONNECTION_STRING");
    const tableClient = TableClient.fromConnectionString(storageConn, "Sessions");

    // Read session
    const entity = await tableClient.getEntity("session", sessionId);

    // Increment question number
    const current = Number(entity.questionNumber || 0);
    const next = current + 1;

    // Keep a tiny running notes string (cheap “memory”)
    const prevNotes = (entity.notes || "").toString();
    const safeAnswer = userAnswer.replace(/\s+/g, " ").slice(0, 120);
    const newNotes = (prevNotes ? prevNotes + " | " : "") + `Q${next}:${safeAnswer}`;
    const notes = newNotes.slice(-800); // cap size

    // Ask model for next question
    const question = await callAzureOpenAI({
      notes,
      questionNumber: next,
      userAnswer: safeAnswer
    });

    // Update session in table
    entity.questionNumber = next;
    entity.lastAnswer = safeAnswer;
    entity.lastQuestion = question;
    entity.notes = notes;
    entity.updatedAt = new Date().toISOString();
    await tableClient.updateEntity(entity, "Merge");

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        text: `Question ${next}/20: ${question}`,
        questionNumber: next
      }
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: {
        text: "Backend error in /api/message",
        details: err && err.message ? err.message : String(err)
      }
    };
  }
};
