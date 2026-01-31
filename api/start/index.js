export default async function (context, req) {
  const sessionId = crypto.randomUUID();

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: {
      sessionId,
      text: "Think of something. I’ll try to guess it in 20 questions."
    }
  };
}
