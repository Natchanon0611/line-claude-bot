const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot is running");
});

app.get("/webhook", (req, res) => {
  res.send("Webhook endpoint is alive");
});

app.post("/webhook", async (req, res) => {
  const events = req.body && req.body.events ? req.body.events : [];
  const event = events[0];

  console.log("EVENT =", JSON.stringify(req.body));

  if (!event || event.type !== "message" || !event.message || event.message.type !== "text") {
    return res.sendStatus(200);
  }

  try {
    const userMsg = event.message.text;

    const claude = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-haiku-20240307",
        max_tokens: 300,
        messages: [{ role: "user", content: userMsg }]
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );

    const reply =
      claude.data &&
      claude.data.content &&
      claude.data.content[0] &&
      claude.data.content[0].text
        ? claude.data.content[0].text
        : "No response";

    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken: event.replyToken,
        messages: [{ type: "text", text: String(reply).slice(0, 1000) }]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.LINE_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.response ? error.response.data : error.message);

    let errorMessage = "เกิดข้อผิดพลาดในการใช้งานบอท";

    const apiError =
      error.response &&
      error.response.data &&
      error.response.data.error &&
      error.response.data.error.message;

    const normalError =
      error.response &&
      error.response.data &&
      error.response.data.message;

    const fallbackError = error.message;

    if (apiError) {
      errorMessage = `Error: ${apiError}`;
    } else if (normalError) {
      errorMessage = `Error: ${normalError}`;
    } else if (fallbackError) {
      errorMessage = `Error: ${fallbackError}`;
    }

    try {
      await axios.post(
        "https://api.line.me/v2/bot/message/reply",
        {
          replyToken: event.replyToken,
          messages: [{ type: "text", text: errorMessage.slice(0, 1000) }]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.LINE_TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );
    } catch (replyError) {
      console.error("Reply error:", replyError.response ? replyError.response.data : replyError.message);
    }

    return res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
