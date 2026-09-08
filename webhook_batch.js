async function processWebhookBatch(events, eventHandler, logger = console) {
  const batch = Array.isArray(events) ? events : [];
  logger.log(`[WEBHOOK] received ${batch.length} event(s)`);

  const results = await Promise.allSettled(batch.map((event) => eventHandler(event)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const messageId = batch[index]?.message?.id || "unknown";
      logger.error(
        `[WEBHOOK] event failed message=${messageId}:`,
        result.reason?.message || result.reason
      );
    }
  });
  return results;
}

module.exports = { processWebhookBatch };
