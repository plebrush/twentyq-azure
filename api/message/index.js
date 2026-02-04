const { TableClient } = require("@azure/data-tables");

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave json null
  }

  return { ok: res.ok, status: res.status, text, json };
}

/**
 * Calls Azure OpenAI in a robust way.
 * It tries:
 *  1) Classic Azure OpenAI deployments endpoint (api-key header)
 *  2) Foundry v1 endpoint with model=deployment name (api-key header)
 *  3) Foundry v1 endpoint with model=model name (api-key header)
 *  4) Same as (2) but using Authorization: Bearer (some configs expect this)
 */
async function callAzureOpenAI({ notes, questionNumber, userAnswer }) {
  const endpoint = env("AZURE_OPENAI_ENDPOINT").replace(/\/+$/, "");
  const apiKey = env("AZURE_OPENAI_KEY");
  const deployment = env("AZURE_OPENAI_DEPLOYMENT");

  // If you deployed gpt-4.1-nano, keep this:
  const modelName = "gpt-4.1-nano";

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

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  const attempts = [];

  // Attempt 1: classic deployments endpoint
  attempts.push({
    name: "classic-deployments",
    url: `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`,
    headers: { "api-key": apiKey },
    body: { messages, temperature: 0.4, max_tokens: 80 }
  });

  // Attempt 2: v1 endpoint, model = deployment name
  attempts.push({
    name: "v1-model=deployment",
    url: `${endpoint}/openai/v1/chat/completions`,
    headers: { "api-key": apiKey },
    body: { model: deployment, messages, temperature: 0.4, max_tokens: 80 }
  });

  // Attempt 3: v1 endpoint, model = model name
  attempts.push({
    name: "v1-model=modelName",
    url: `${endpoint}/openai/v1/chat/completions`,
    headers: { "api-key": apiKey },
    body: { model: modelName, messages, temperature: 0.4, max_tokens: 80 }
  });

  // Attempt 4: v1 endpoint, Authorization Bearer (some tenants)
  attempts.push({
    name: "v1-bearer-model=deployment",
    url: `${endpoint}/openai/v1/chat/completions`,
    headers: { Authorization: `Bearer ${apiKey}` },
    body: { model: deployment, messages, temperature: 0.4, max_tokens: 80 }
  });

  let lastError = null;

  for (const a of attempts) {
    const r = await postJson(a.url, a.headers, a.body);

    if (r.ok && r.json) {
      const content =
        r.json?.choices?.[0]?.message?.content?.trim() ||
        r.json?.choices?.[0]?.text?.trim();

      if (content) {
        const q = content.endsWith("?") ? content : `${content}?`;
        return { question: q, used: a.name };
      }

      lastError = new Error(`OpenAI ${a.name} returned no content`);
      continue;
    }

    // capture useful error details
    lastError = new Error(
      `OpenAI ${a.name} failed (${r.status}): ${r.text || "(empty response)"}`
    );

    // if it’s clearly auth, don’t bother trying more formats with same header
    // but we still try the Bearer variant later.
    continue;
  }

  throw lastError || new Error("Azure OpenAI call failed");
}

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const sessionId = body.sessionId;
    const userAnswer = (body.userAnswer || "").toString().trim().toLowerCase();

    if (!sessionId) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { text: "Missing sessionId." }
      };
      return;
    }

    const storageConn = env("STORAGE_CONNECTION_STRING");
    const tableClient = TableClient.fromConnectionString(storageConn, "Sessions");

    // Read session
    const entity = await tableClient.getEntity("session", sessionId);

    const current = Number(entity.questionNumber || 0);
    const next = current + 1;

    // Update notes (tiny memory)
    const prevNotes = (entity.notes || "").toString();
    const safeAnswer = userAnswer.replace(/\s+/g, " ").slice(0, 120);
    const updatedNotes =
      (prevNotes ? prevNotes + " | " : "") + `Q${next}:${safeAnswer}`;
    const notes = updatedNotes.slice(-800);

    // Call Azure OpenAI for next question
    const { question, used } = await callAzureOpenAI({
      notes,
      questionNumber: next,
      userAnswer: safeAnswer
    });

    // Persist state
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
        questionNumber: next,
        debug: { openaiRoute: used }
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
