const { TableClient } = require("@azure/data-tables");

module.exports = async function (context, req) {
  try {
    const connectionString = process.env.STORAGE_CONNECTION_STRING;

    if (!connectionString) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing STORAGE_CONNECTION_STRING environment variable" }
      };
      return;
    }

    const tableClient = TableClient.fromConnectionString(
      connectionString,
      "Sessions"
    );

    const sessionId =
      Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

    await tableClient.createEntity({
      partitionKey: "session",
      rowKey: sessionId,
      questionNumber: 0,
      notes: "",
      askedJson: "[]", // IMPORTANT: list of questions already asked
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        sessionId,
        text: "Think of something. I’ll try to guess it in 20 questions."
      }
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: {
        error: "Start failed",
        details: err && err.message ? err.message : String(err)
      }
    };
  }
};
