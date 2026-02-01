const { TableClient } = require("@azure/data-tables");

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const sessionId = body.sessionId;
    const userAnswer = (body.userAnswer || "").toString().trim();

    if (!sessionId) {
      context.res = { status: 400, body: { text: "Missing sessionId." } };
      return;
    }

    const connectionString = process.env.STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      context.res = { status: 500, body: { text: "Missing STORAGE_CONNECTION_STRING." } };
      return;
    }

    const tableClient = TableClient.fromConnectionString(connectionString, "Sessions");

    // Read session
    const entity = await tableClient.getEntity("session", sessionId);

    // Increment question number
    const current = Number(entity.questionNumber || 0);
    const next = current + 1;

    // Update session
    entity.questionNumber = next;
    entity.lastAnswer = userAnswer;
    entity.updatedAt = new Date().toISOString();

    await tableClient.updateEntity(entity, "Merge");

    // Simple stub question bank (we’ll replace with AI later)
    const questions = [
      "Is it a living thing?",
      "Is it something you can hold in one hand?",
      "Is it bigger than a microwave?",
      "Would you find it inside a house?",
      "Is it something humans made?"
    ];

    const qText = questions[(next - 1) % questions.length];

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        text: `Answer recorded: "${userAnswer}".\nQuestion ${next}/20: ${qText}`,
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
