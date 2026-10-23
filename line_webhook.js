"use strict";

const crypto = require("node:crypto");

// LINE signs the original bytes, before JSON parsing or reformatting.
function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!Buffer.isBuffer(rawBody) || typeof channelSecret !== "string" || !channelSecret) return false;
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const received = Buffer.from(signature, "base64");
  const expected = crypto.createHmac("sha256", channelSecret).update(rawBody).digest();
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function registerLineWebhook(app, { express, channelSecret, processEvents, logger = console }) {
  if (typeof channelSecret !== "string" || !channelSecret.trim() || channelSecret !== channelSecret.trim()) {
    throw new Error("LINE_CHANNEL_SECRET is required and must not contain surrounding whitespace");
  }
  // Register before any global JSON parser. Reject compressed bodies rather than
  // verifying bytes that a parser has already transformed.
  app.post("/webhook", express.raw({ type: "application/json", limit: "20mb", inflate: false }), (req, res) => {
    if (!verifyLineSignature(req.body, req.headers["x-line-signature"], channelSecret)) {
      return res.status(401).json({ error: "Invalid LINE signature" });
    }
    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid webhook JSON" });
    }
    if (!payload || Array.isArray(payload) || !Array.isArray(payload.events)
        || payload.events.some(event => !event || typeof event !== "object" || Array.isArray(event))) {
      return res.status(400).json({ error: "Invalid webhook events" });
    }
    logger.log(`[LINE] verified webhook: ${payload.events.length} event(s)`);
    res.sendStatus(200);
    // Do not log request bodies, access tokens, or signatures.
    if (payload.events.length) {
      Promise.resolve().then(() => processEvents(payload.events)).catch(() => {
        logger.error("[LINE] verified webhook batch processing failed");
      });
    }
  });
}

module.exports = { verifyLineSignature, registerLineWebhook };
