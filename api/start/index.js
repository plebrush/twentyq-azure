const { TableClient, TableServiceClient } = require("@azure/data-tables");

module.exports = async function (context, req) {
  const connectionString = process.env.STORAGE_CONNECTION_STRING;

  if (!connectionString) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Missing STORAGE_CONNECTION_STRING (Static Web App → Environment variables)" }
    };
    return;
  }

  const tableName = "Sessions";

  // Create table if needed (safe if it already exists)
  try {
    const serviceClient = TableServiceClient.fromConnectionString(connectionString);
    await serviceClient.createTable(tableName);
  } catch (e) {
    // 409 = already exists, ignore it
    if (!(e && (e.statusCode === 409 || e.code === "TableAlreadyExists"))) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: "Failed creating table", details: e.message || String(e) }
      };
      return;
    }
  }

  const tableClient = TableClient.fromConnectionString(connectionString, tableName);

  const sessionId =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

  const entity = {
    partitionKey: "session",
    rowKey: sessionId,
    questionNumber: 0,
    createdAt: new Date().toISOString()
  };

  try {
    await tableClient.createEntity(entity);

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        sessionId,
        wroteToTable: true,
        text: "Think of something. I’ll try to guess it in 20 questions. (storage write OK)"
      }
    };
  } catch (e) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: {
        sessionId,
        wroteToTable: false,
        error: "Failed writing session entity",
        details: e.message || String(e)
      }
    };
  }
};
