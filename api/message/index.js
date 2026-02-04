const { TableClient } = require("@azure/data-tables");

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function normalizeText(t) {
  return (t || "").toString().trim().replace(/\s+/g, " ").replace(/^["'“”]+|["'“”]+$/g, "");
}

function clamp(s, n) {
  const t = (s || "").toString();
  return t.length > n ? t.slice(0, n) : t;
}

function isYes(a) { return normalizeText(a).toLowerCase() === "yes"; }
function isNo(a) { return normalizeText(a).toLowerCase() === "no"; }

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

/**
 * Facts schema we maintain:
 * {
 *   living: true/false/null,
 *   plant: true/false/null,
 *   animal: true/false/null
 * }
 *
 * We start small with just these 3 because they prevent your exact issue.
 * Later we can expand facts safely.
 */
function initFacts(existing) {
  const f = existing && typeof existing === "object" ? existing : {};
  return {
    living: typeof f.living === "boolean" ? f.living : null,
    plant: typeof f.plant === "boolean" ? f.plant : null,
    animal: typeof f.animal === "boolean" ? f.animal : null
  };
}

/**
 * Update facts based on the last question + user's answer.
 * This is small “game engine” logic, not hardcoding the whole game,
 * just preventing contradictions on the most common funnel.
 */
function updateFactsFromQA(facts, lastQ, answer) {
  const q = normalizeText(lastQ).toLowerCase();

  // Only map very specific standard questions
  if (q.includes("living thing")) facts.living = isYes(answer) ? true : isNo(answer) ? false : facts.living;
  if (q === "is it a plant?" || q.includes("is it a plant")) facts.plant = isYes(answer) ? true : isNo(answer) ? false : facts.plant;
  if (q === "is it an animal?" || q.includes("is it an animal")) facts.animal = isYes(answer) ? true : isNo(answer) ? false : facts.animal;

  // Derived logic: plant => living, animal => living
  if (facts.plant === true) facts.living = true;
  if (facts.animal === true) facts.living = true;

  // Derived logic: plant true => animal false (and vice versa)
  if (facts.plant === true) facts.animal = false;
  if (facts.animal === true) facts.plant = false;

  return facts;
}

function contradictsFacts(facts, nextQuestion) {
  const q = normalizeText(nextQuestion).toLowerCase();

  // If we already know it's a plant, asking "animal?" is a contradiction.
  if (facts.plant === true && (q === "is it an animal?" || q.includes("is it an animal"))) return true;
  if (facts.animal === true && (q === "is it a plant?" || q.includes("is it a plant"))) return true;

  // If we already know "not living", asking plant/animal is contradiction
  if (facts.living === false && (q.includes("is it a plant") || q.includes("is it an animal"))) return true;

  // If we already know living=true, asking "Is it a living thing?" is redundant
  if (facts.living === true && q.includes("is it a living thing")) return true;

  return false;
}

/**
 * AI must return strict JSON:
 * {
 *   "type": "question"|"guess",
 *   "text": "...?",
 *   "notes": "...",
 *   "facts": { "living": true/false/null, "plant": true/false/null, "animal": true/false/null }
 * }
 */
async function callAzureOpenAI_JSON({ notes, facts, questionNumber, userAnswer, asked }) {
  const endpoint = env("AZURE_OPENAI_ENDPOINT").replace(/\/+$/, "");
  const apiKey = env("AZURE_OPENAI_KEY");
  const deployment = env("AZURE_OPENAI_DEPLOYMENT");
  const modelName = "gpt-4.1-nano";

  const askedList = (asked || []).slice(-25);
  const askedText =
    askedList.length > 0 ? askedList.map((q, i) => `${i + 1}. ${q}`).join("\n") : "(none yet)";

  const system = [
    "You are the game engine for 20 Questions.",
    "You must output ONLY valid JSON (no markdown, no extra text).",
    "",
    "Return this exact JSON shape:",
    '{ "type": "question" | "guess", "text": string, "notes": string, "facts": { "living": boolean|null, "plant": boolean|null, "animal": boolean|null } }',
    "",
    "Rules:",
    "- If you are NOT confident yet, type must be 'question' and text must be a single YES/NO question ending with '?'.",
    "- Only use type='guess' when you are making a SPECIFIC object guess (e.g. 'Is it a toaster?').",
    "- Do NOT end the game with generic category guesses like 'Is it living?'.",
    "- Do NOT repeat any question from the Previously asked list.",
    "- Do NOT contradict known facts. Example: if plant=true, do NOT ask animal.",
    "- Update facts correctly: plant=true implies animal=false and living=true.",
    "- Keep notes short (<=200 chars)."
  ].join("\n");

  const user = [
    `Turn: ${questionNumber}/20`,
    `User answered: ${userAnswer || "(none yet)"}`,
    `Current notes: ${notes || "(none)"}`,
    `Known facts JSON: ${JSON.stringify(facts)}`,
    `Previously asked (do not repeat):\n${askedText}`,
    "",
    "Now output the next step as JSON."
  ].join("\n");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  const attempts = [
    {
      name: "classic-deployments",
      url: `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`,
      headers: { "api-key": apiKey },
      body: { messages, temperature: 0.4, max_tokens: 220 }
    },
    {
      name: "v1-model=deployment",
      url: `${endpoint}/openai/v1/chat/completions`,
      headers: { "api-key": apiKey },
      body: { model: deployment, messages, temperature: 0.4, max_tokens: 220 }
    },
    {
      name: "v1-model=modelName",
      url: `${endpoint}/openai/v1/chat/completions`,
      headers: { "api-key": apiKey },
      body: { model: modelName, messages, temperature: 0.4, max_tokens: 220 }
    }
  ];

  let lastError = null;

  for (const a of attempts) {
    const r = await postJson(a.url, a.headers, a.body);
    if (r.ok && r.json) {
      const content =
        r.json?.choices?.[0]?.message?.content?.trim() ||
        r.json?.choices?.[0]?.text?.trim();

      const parsed = safeJsonParse(content, null);
      if (!parsed || typeof parsed !== "object") {
        lastError = new Error(`Model did not return JSON: ${content}`);
        continue;
      }

      const type = (parsed.type || "").toString().toLowerCase();
      let text = normalizeText(parsed.text || "");
      let newNotes = normalizeText(parsed.notes || "");
      const newFacts = initFacts(parsed.facts);

      if (type !== "question" && type !== "guess") {
        lastError = new Error(`Invalid type: ${type}`);
        continue;
      }
      if (!text) {
        lastError = new Error("Missing text");
        continue;
      }
      if (!text.endsWith("?")) text += "?";
      newNotes = clamp(newNotes, 200);

      return { type, text, notes: newNotes, facts: newFacts, used: a.name };
    }

    lastError = new Error(`OpenAI ${a.name} failed (${r.status}): ${r.text || "(empty)"}`);
  }

  throw lastError || new Error("Azure OpenAI call failed");
}

async function getValidNextStep({ notes, facts, questionNumber, userAnswer, asked }) {
  const askedSet = new Set((asked || []).map((q) => normalizeText(q).toLowerCase()));

  for (let i = 0; i < 5; i++) {
    const step = await callAzureOpenAI_JSON({ notes, facts, questionNumber, userAnswer, asked });
    const norm = normalizeText(step.text).toLowerCase();

    // No repeats
    if (askedSet.has(norm)) continue;

    // No contradictions (backend enforcement)
    if (contradictsFacts(facts, step.text)) continue;

    return step;
  }

  // Safe fallback based on facts
  if (facts.plant === true) {
    return { type: "question", text: "Is it something you would find in a garden?", notes: clamp(notes || "", 200), facts, used: "fallback" };
  }
  if (facts.animal === true) {
    return { type: "question", text: "Is it a domesticated animal?", notes: clamp(notes || "", 200), facts, used: "fallback" };
  }
  return { type: "question", text: "Is it something you can hold in one hand?", notes: clamp(notes || "", 200), facts, used: "fallback" };
}

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const sessionId = body.sessionId;
    const userAnswerRaw = (body.userAnswer || "").toString().trim();
    const playerNameRaw = (body.playerName || "").toString().trim();

    if (!sessionId) {
      context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { text: "Missing sessionId." } };
      return;
    }

    const playerName = playerNameRaw ? clamp(playerNameRaw, 24) : "Anonymous";
    const safeAnswer = clamp(userAnswerRaw.replace(/\s+/g, " "), 120);

    const storageConn = env("STORAGE_CONNECTION_STRING");
    const sessionsClient = TableClient.fromConnectionString(storageConn, "Sessions");
    const scoresClient = TableClient.fromConnectionString(storageConn, "Scores");

    const entity = await sessionsClient.getEntity("session", sessionId);

    // Load/maintain facts
    let facts = initFacts(safeJsonParse(entity.factsJson || "{}", {}));

    // Update facts from the LAST question and the user's current answer
    const prevQ = entity.lastQuestion || "";
    if (prevQ && safeAnswer) {
      facts = updateFactsFromQA(facts, prevQ, safeAnswer);
    }

    // Win condition (AI-driven): only if lastType was 'guess' and user says yes
    const lastType = (entity.lastType || "").toString().toLowerCase();
    const won = lastType === "guess" && isYes(safeAnswer);

    if (won) {
      const guess = prevQ; // lastQuestion stores the guess text
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
      entity.factsJson = JSON.stringify(facts);
      await sessionsClient.updateEntity(entity, "Merge");

      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { text: `🎉 Nice! I got it in ${questionsTaken} questions. Score saved for ${playerName}.`, won: true, questionsTaken, guess }
      };
      return;
    }

    // Continue game
    const current = Number(entity.questionNumber || 0);
    const next = current + 1;

    const asked = safeJsonParse(entity.askedJson || "[]", []);
    const askedClean = Array.isArray(asked) ? asked : [];

    const prevNotes = (entity.notes || "").toString();

    const step = await getValidNextStep({
      notes: prevNotes,
      facts,
      questionNumber: next,
      userAnswer: safeAnswer,
      asked: askedClean
    });

    askedClean.push(step.text);

    entity.questionNumber = next;
    entity.lastAnswer = safeAnswer;
    entity.lastQuestion = step.text;
    entity.lastType = step.type;
    entity.notes = step.notes || clamp(prevNotes, 200);
    entity.factsJson = JSON.stringify(step.facts || facts);
    entity.askedJson = JSON.stringify(askedClean.slice(-60));
    entity.updatedAt = new Date().toISOString();
    await sessionsClient.updateEntity(entity, "Merge");

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        text: `Question ${next}/20: ${step.text}`,
        questionNumber: next,
        debug: { openaiRoute: step.used, type: step.type, facts: step.facts || facts }
      }
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { text: "Backend error in /api/message", details: err && err.message ? err.message : String(err) }
    };
  }
};
