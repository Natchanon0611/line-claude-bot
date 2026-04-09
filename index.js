const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const event = req.body.events[0];

  if (event.type !== "message") return res.sendStatus(200);

  const userMsg = event.message.text;

  const claude = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-3-haiku-20240307",
      max_tokens: 500,
      messages: [{ role: "user", content: userMsg }]
    },
    {
      headers: {
        "x-api-key": process.env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01"
      }
    }
  );

  const reply = claude.data.content[0].text;

  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken: event.replyToken,
      messages: [{ type: "text", text: reply }]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.LINE_TOKEN}`
      }
    }
  );

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000);
