const { TableClient } = require("@azure/data-tables");

module.exports = async function (context, req) {
  const connectionString = process.env.STORAGE_CONNECTION_STRING;
  const tableClient = TableClient.fromConnectionString(
    connectionString,
    "Sessions"
  );

  const sessionId =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

  const entity = {
    partitionKey: "session",
    rowKey: sessionId,
    questionNumber: 0,
    createdAt: new Date().toISOString()
  };

  await tableClient.createEntity(entity);

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: {
      sessionId,
      text: "Think of something. I’ll try to guess it in 20 questions."
    }
  };
};
