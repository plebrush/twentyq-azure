module.exports = async function (context, req) {
  const body = req.body || {};
  const sessionId = body.sessionId;
  const userAnswer = (body.userAnswer || "").toString().trim().toLowerCase();

  if (!sessionId) {
    context.res = { status: 400, body: { text: "Missing sessionId." } };
    return;
  }

  // Simple stub logic (we’ll replace with real game + AI next)
  const text =
    `Got it: "${userAnswer}".\n` +
    `Question 1/20: Is it a living thing?`;

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: { text }
  };
};
