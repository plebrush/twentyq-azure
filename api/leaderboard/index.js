const { TableClient } = require("@azure/data-tables");

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

module.exports = async function (context, req) {
  try {
    const storageConn = env("STORAGE_CONNECTION_STRING");
    const scoresClient = TableClient.fromConnectionString(storageConn, "Scores");

    // Get top 10 scores (lowest questions is best)
    // We'll store PartitionKey="score", RowKey = timestamp-sessionId
    // Fields: name, questions, guess, createdAt
    const results = [];
    const iter = scoresClient.listEntities({
      queryOptions: { filter: `PartitionKey eq 'score'` }
    });

    for await (const e of iter) {
      results.push({
        name: e.name || "Anonymous",
        questions: Number(e.questions || 999),
        guess: e.guess || "",
        createdAt: e.createdAt || ""
      });
    }

    results.sort((a, b) => a.questions - b.questions);

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { top: results.slice(0, 10) }
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: {
        error: "Leaderboard failed",
        details: err && err.message ? err.message : String(err)
      }
    };
  }
};
