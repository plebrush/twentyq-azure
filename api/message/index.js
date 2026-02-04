const { TableClient } = require("@azure/data-tables");

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function normalizeText(t) {
  return (t || "")
    .toString()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["'“”]+|["'“”]+$/g, "");
}

function clamp(s, n) {
  const t = (s || "").toString();
  return t.length > n ? t.slice(0, n) : t;
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
    // ignore
  }

  return { ok: res.ok, status: res.status, text, json };
}

/**
 * Ask model to return strict JSON:
 * { "type": "question"|"guess", "text": "...?", "notes": "..." }
 */
async function callAzureOpenAI_JSON({ notes, questionNumber, userAnswer, asked }) {
  const endpoint = env("AZURE_OPENAI_ENDPOINT").replace(/\/+$/, "");
  const apiKey = env("AZURE_OPENAI_KEY");
  const deployment = env("AZURE_OPENAI_DEPLOYMENT");
  const modelName = "gpt-4.1-nano";

  const askedList = (asked || []).slice(-25);
  const askedText =
    askedList.length > 0
      ? askedList.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "(none yet)";

  const system = [
    "You are the game engine for 20 Questions.",
    "You must output ONLY valid JSON (no markdown, no extra text).",
    "",
    "Return this exact JSON shape:",
    '{ "type": "question" | "guess", "text": string, "notes": string }',
    "",
    "Rules:",
    "- If you are NOT confident yet, type must be 'question' and text must be a single YES/NO question ending with '?'.",
    "- Only use type='guess' when you are making a SPECIFIC final guess (a noun/thing), like: 'Is it a toaster?'.",
    "- Do NOT end the game with generic category guesses like 'Is it living?' or 'Is it for entertainment?'. Those are questions, not guesses.",
    "- Do NOT repeat any question from the Previously asked list.",
    "- Keep notes short (<= 200 chars): key facts learned so far.",
    "- Max 20 turns."
  ].join("\n");

  const user = [
    `Turn: ${questionNumber}/20`,
    `User answered: ${userAnswer || "(none yet)"}`,
    `Current notes: ${notes || "(none)"}`,
    `Previously asked (do not repeat):\n${askedText}`,
    "",
    "Now output the next step as JSON."
  ].join("\n");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  const attempts = [];

  // A) classic deployments endpoint
  attempts.push({
    name: "classic-deployments",
    url: `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`,
    headers: { "api-key": apiKey },
    body: { messages, temperature: 0.4, max_tokens: 160 }
  });

  // B) v1 endpoint model=deployment
  attempts.push({
    name: "v1-model=deployment",
    url: `${endpoint}/openai/v1/chat/completions`,
    headers: { "api-key": apiKey },
    body: { model: deployment, messages, temperature: 0.4, max_tokens: 160 }
  });

  // C) v1 endpoint model=modelName
  attempts.push({
    name: "v1-model=modelName",
    url: `${endpoint}/openai/v1/chat/completions`,
    headers: { "api-key": apiKey },
    body: { model: modelName, messages, temperature: 0.4, max_tokens: 160 }
  });

  let lastError = null;

  for (const a of attempts) {
    const r = await postJson(a.url, a.headers, a.body);

    if (r.ok && r.json) {
      const content =
        r.json?.choices?.[0]?.message?.content?.trim() ||
        r.json?.choices?.[0]?.text?.trim();

      if (!content) {
        lastError = new Error(`OpenAI ${a.name} returned no content`);
        continue;
      }

      // Parse the JSON the model returned
      const parsed = safeJsonParse(content, null);
      if (!parsed || typeof parsed !== "object") {
        lastError = new Error(`OpenAI ${a.name} did not return valid JSON: ${content}`);
        continue;
      }

      const type = (parsed.type || "").toString().toLowerCase();
      let text = normalizeText(parsed.text || "");
      let newNotes = normalizeText(parsed.notes || "");

      if (type !== "question" && type !== "guess") {
        lastError = new Error(`OpenAI ${a.name} invalid type: ${type}`);
        continue;
      }

      if (!text) {
        lastError = new Error(`OpenAI ${a.name} missing text`);
        continue;
      }

      if (!text.endsWith("?")) text += "?";
      newNotes = clamp(newNotes, 200);

      return { type, text, notes: newNotes, used: a.name };
    }

    lastError = new Error(
      `OpenAI ${a.name} failed (${r.status}): ${r.text || "(empty response)"}`
    );
  }

  throw lastError || new Error("Azure OpenAI call failed");
}

/**
 * Non-repeat wrapper: if model repeats, retry a few times.
 * Uses asked array to detect repeats.
 */
async function getNonRepeatingStep({ notes, questionNumber, userAnswer, asked }) {
  const askedSet = new Set((asked || []).map((q) => normalizeText(q).toLowerCase()));

  for (let i = 0; i < 4; i++) {
    const step = await callAzureOpenAI_JSON({ notes, questionNumber, userAnswer, asked });
    const norm = normalizeText(step.text).toLowerCase();
    if (!askedSet.has(norm)) return step;
  }

  // fallback question only (never a guess)
  return {
    type: "question",
    text: "Is it something you can hold in one hand?",
    notes: clamp(notes || "", 200),
    used: "fallback"
  };
}

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const sessionId = body.sessionId;
    const userAnswerRaw = (body.userAnswer || "").toString().trim();
    const playerNameRaw = (body.playerName || "").toString().trim();

    if (!sessionId) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { text: "Missing sessionId." }
      };
      return;
    }

    const playerName = playerNameRaw ? clamp(playerNameRaw, 24) : "Anonymous";
    const safeAnswer = clamp(userAnswerRaw.replace(/\s+/g, " "), 120);

    const storageConn = env("STORAGE_CONNECTION_STRING");
    const sessionsClient = TableClient.fromConnectionString(storageConn, "Sessions");
    const scoresClient = TableClient.fromConnectionString(storageConn, "Scores");

    const entity = await sessionsClient.getEntity("session", sessionId);

    // Win check is now AI-driven:
    // only if previous bot step was type='guess'
    const lastType = (entity.lastType || "").toString().toLowerCase();
    const lastQ = entity.lastQuestion || "";
    const won = lastType === "guess" && safeAnswer.toLowerCase() === "yes";

    if (won) {
      const guess = lastQ;
      const questionsTaken = Number(entity.questionNumber || 0);

      const rowKey = `${Date.now()}-${sessionId}`;
      await scoresClient.createEntity({
        partitionKey: "score",
        rowKey,
        name: playerName,
        questions: questionsTaken,
        guess,
        createdAt: new Date().toISOString()
      });

      entity.completed = true;
      entity.completedAt = new Date().toISOString();
      await sessionsClient.updateEntity(entity, "Merge");

      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: {
          text: `🎉 Nice! I got it in ${questionsTaken} questions. Score saved for ${playerName}.`,
          won: true,
          questionsTaken,
          guess
        }
      };
      return;
    }

    // Continue game
    const current = Number(entity.questionNumber || 0);
    const next = current + 1;

    const asked = safeJsonParse(entity.askedJson || "[]", []);
    const askedClean = Array.isArray(asked) ? asked : [];

    const prevNotes = (entity.notes || "").toString();

    const step = await getNonRepeatingStep({
      notes: prevNotes,
      questionNumber: next,
      userAnswer: safeAnswer,
      asked: askedClean
    });

    // Track asked questions regardless of type
    askedClean.push(step.text);

    // Notes: prefer model notes if provided, else keep existing
    const notesToSave = step.notes ? step.notes : clamp(prevNotes, 200);

    entity.questionNumber = next;
    entity.lastAnswer = safeAnswer;
    entity.lastQuestion = step.text;     // store question/guess text
    entity.lastType = step.type;         // store whether it was question or guess
    entity.notes = notesToSave;
    entity.askedJson = JSON.stringify(askedClean.slice(-60));
    entity.updatedAt = new Date().toISOString();
    await sessionsClient.updateEntity(entity, "Merge");

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        text: `Question ${next}/20: ${step.text}`,
        questionNumber: next,
        debug: { openaiRoute: step.used, type: step.type }
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
