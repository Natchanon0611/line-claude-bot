const test = require("node:test");
const assert = require("node:assert/strict");

const { processWebhookBatch } = require("../webhook_batch");

const silentLogger = { log() {}, error() {} };

test("processes all four LINE events in one webhook batch", async () => {
  const events = ["1", "2", "3", "4"].map((id) => ({ message: { id } }));
  const processed = [];

  const results = await processWebhookBatch(events, async (event) => {
    processed.push(event.message.id);
  }, silentLogger);

  assert.deepEqual(processed.sort(), ["1", "2", "3", "4"]);
  assert.equal(results.length, 4);
  assert.ok(results.every((result) => result.status === "fulfilled"));
});

test("one failed event does not prevent the rest of the batch", async () => {
  const events = ["1", "2", "3", "4"].map((id) => ({ message: { id } }));
  const processed = [];

  const results = await processWebhookBatch(events, async (event) => {
    if (event.message.id === "2") throw new Error("temporary failure");
    processed.push(event.message.id);
  }, silentLogger);

  assert.deepEqual(processed.sort(), ["1", "3", "4"]);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});
