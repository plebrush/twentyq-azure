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

function normalizeQuestion(q) {
  return (q || "")
    .toString()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[\-\*\d\.\)\s]+/, "")
    .replace(/^["'“”]+|["'“”]+$/g, "");
}

function isGuessQuestion(q) {
  const t = normalizeQuestion(q).toLowerCase();
  // Basic “guess” heuristic
  return t.startsWith("is it ") && t.endsWith("?");
}

function extractGuessText(q) {
  const t = normalizeQuestion(q);
  // "Is it a toaster?" -> "a toaster"
  const m = t.match(/^Is it\s+(.*)\?$/i);
  return m ? m[1].trim() : "";
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

async function callAzureOpenAI({ notes, questionNumber, userAnswer, asked }) {
  const endpoint = env("AZURE_OPENAI_ENDPOINT").replace(/\/+$/, "");
  const apiKey = env("AZURE_OPENAI_KEY");
  const deployment = env("AZURE_OPENAI_DEPLOYMENT");

  // Your deployed model name (from Foundry details)
  const modelName = "gpt-4.1-nano";

  const askedList = (asked || []).slice(-20);
  const askedText =
    askedList.length > 0
      ? askedList.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "(none yet)";

  const system = [
    "You are playing 20 Questions.",
    "Ask exactly ONE yes/no question at a time to guess the user's secret object.",
    "CRITICAL RULES:",
    "- Output MUST be only the question text.",
    "- It must be a YES/NO style question.",
    "- Do NOT repeat any question from the Previously asked list.",
    "- Keep it short and specific.",
    "- If very confident, ask: 'Is it <your guess>?'",
    "- Max 20 questions total."
  ].join("\n");

  const user = [
    `We are on question ${questionNumber}/20.`,
    `User just answered: ${userAnswer || "(none yet)"}`,
    `Notes (compressed): ${notes || "(none)"}`,
    `Previously asked (DO NOT REPEAT):\n${askedText}`,
    "Now ask the best next yes/no question."
  ].join("\n");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  const attempts = [];

  attempts.push({
    name: "classic-deployments",
    url: `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`,
    headers: { "api-key": apiKey },
    body: { messages, temperature: 0.4, max_tokens: 80 }
  });

  attempts.push({
    name: "v1-model=deployment",
    url: `${endpoint}/openai/v1/chat/completions`,
    headers: { "api-key": apiKey },
    body: { model: deployment, messages, temperature: 0.4, max_tokens: 80 }
  });

  attempts.push({
    name: "v1-model=modelName",
    url: `${endpoint}/openai/v1/chat/completions`,
    headers: { "api-key": apiKey },
    body: { model: modelName, messages, temperature: 0.4, max_tokens: 80 }
  });

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
        let q = normalizeQuestion(content);
        if (!q.endsWith("?")) q = `${q}?`;
        return { question: q, used: a.name };
      }

      lastError = new Error(`OpenAI ${a.name} returned no content`);
      continue;
    }

    lastError = new Error(
      `OpenAI ${a.name} failed (${r.status}): ${r.text || "(empty response)"}`
    );
  }

  throw lastError || new Error("Azure OpenAI call failed");
}

async function getNonRepeatingQuestion({ notes, questionNumber, userAnswer, asked }) {
  const askedSet = new Set((asked || []).map((q) => normalizeQuestion(q).toLowerCase()));

  for (let i = 0; i < 3; i++) {
    const { question, used } = await callAzureOpenAI({
      notes,
      questionNumber,
      userAnswer,
      asked
    });

    const norm = normalizeQuestion(question).toLowerCase();
    if (!askedSet.has(norm)) {
      return { question, used };
    }
  }

  const fallback = [
    "Is it an animal?",
    "Is it a plant?",
    "Is it something you’d find indoors?",
    "Is it used for work or productivity?",
    "Is it used for entertainment?",
    "Is it electronic?",
    "Is it made of metal?",
    "Is it something you can wear?",
    "Is it a type of food?",
    "Is it found in a kitchen?"
  ];

  for (const q of fallback) {
    const norm = normalizeQuestion(q).toLowerCase();
    if (!askedSet.has(norm)) {
      return { question: q, used: "fallback" };
    }
  }

  return { question: "Is it something you can hold in one hand?", used: "last-resort" };
}

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const sessionId = body.sessionId;
    const userAnswerRaw = (body.userAnswer || "").toString().trim();

    if (!sessionId) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { text: "Missing sessionId." }
      };
      return;
    }

    const storageConn = env("STORAGE_CONNECTION_STRING");
    const sessionsClient = TableClient.fromConnectionString(storageConn, "Sessions");
    const scoresClient = TableClient.fromConnectionString(storageConn, "Scores");

    // Read session
    const entity = await sessionsClient.getEntity("session", sessionId);

    const current = Number(entity.questionNumber || 0);
    const next = current + 1;

    const asked = safeJsonParse(entity.askedJson || "[]", []);
    const askedClean = Array.isArray(asked) ? asked : [];

    const prevNotes = (entity.notes || "").toString();
    const safeAnswer = userAnswerRaw.replace(/\s+/g, " ").slice(0, 120);

    // ✅ WIN DETECTION: if last question was a guess and user says "yes"
    const lastQ = entity.lastQuestion || "";
    const won = isGuessQuestion(lastQ) && safeAnswer.toLowerCase() === "yes";

    if (won) {
      const guess = extractGuessText(lastQ) || "(unknown)";
      const questionsTaken = Number(entity.questionNumber || 0);

      // Write score row
      const rowKey = `${Date.now()}-${sessionId}`;
      await scoresClient.createEntity({
        partitionKey: "score",
        rowKey,
        name: "Seb", // change later when we add name input
        questions: questionsTaken,
        guess,
        createdAt: new Date().toISOString()
      });

      // Reset the session (optional): mark as complete
      entity.completed = true;
      entity.completedAt = new Date().toISOString();
      await sessionsClient.updateEntity(entity, "Merge");

      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: {
          text: `🎉 Nice! I got it in ${questionsTaken} questions. Score saved.`,
          won: true,
          questionsTaken,
          guess
        }
      };
      return;
    }

    // Get a non-repeating question
    const { question, used } = await getNonRepeatingQuestion({
      notes: prevNotes,
      questionNumber: next,
      userAnswer: safeAnswer,
      asked: askedClean
    });

    askedClean.push(question);

    const newNotesLine = `Q${next}: ${question} | A: ${safeAnswer}`;
    const combinedNotes = (prevNotes ? prevNotes + "\n" : "") + newNotesLine;
    const notes = combinedNotes.slice(-2000);

    // Persist state
    entity.questionNumber = next;
    entity.lastAnswer = safeAnswer;
    entity.lastQuestion = question;
    entity.notes = notes;
    entity.askedJson = JSON.stringify(askedClean.slice(-50));
    entity.updatedAt = new Date().toISOString();
    await sessionsClient.updateEntity(entity, "Merge");

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
