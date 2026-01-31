module.exports = async function (context, req) {
  // Simple session id without relying on crypto.randomUUID
  const sessionId =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: {
      sessionId,
      text: "Think of something. I’ll try to guess it in 20 questions."
    }
  };
};
