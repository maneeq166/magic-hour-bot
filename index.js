require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const cron = require("node-cron");
const express = require("express");
const { MongoClient } = require("mongodb");
const MagicHourImport = require("magic-hour");

// === Initialize Magic Hour SDK ===
const MagicHour = MagicHourImport.default || MagicHourImport;
const mh = new MagicHour({ token: process.env.MH_API_KEY });

// === GLOBAL STATE ===
let db, tokens;
const channelMap = new Map();

// === MONGODB CONNECTION ===
async function connectMongo() {
  try {
    console.log("📡 [MONGO] Connecting to MongoDB...");
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    db = client.db("magic_hour_bot");
    tokens = db.collection("workspace_tokens");
    console.log("✅ [MONGO] MongoDB connected successfully!");
  } catch (err) {
    console.error("❌ [MONGO] Connection failed:", err);
    process.exit(1);
  }
}

// === SLACK RECEIVER & APP ===
console.log("⚙️ [BOOT] Setting up ExpressReceiver and Slack App...");
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});
const server = receiver.app;
const app = new App({
  receiver,
  token: process.env.SLACK_BOT_TOKEN, // Fallback only
});
console.log("✅ [BOOT] Slack app initialized.");

// === HEALTH ENDPOINT ===
server.get("/", (req, res) => {
  console.log("🌐 [HTTP] Health check request received.");
  res.send("✅ Magic Hour Slack Bot is live and healthy.");
});

// === OAUTH HANDLER ===
server.get("/slack/oauth_redirect", async (req, res) => {
  const { code } = req.query;
  console.log("⚡ [OAUTH] Received OAuth redirect. Code:", code);
  if (!code) {
    console.error("❌ [OAUTH] Missing code in query.");
    return res.status(400).send("Missing code.");
  }

  try {
    console.log("📤 [OAUTH] Requesting token exchange from Slack...");
    const response = await app.client.oauth.v2.access({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: process.env.REDIRECT_URI,
    });

    console.log("✅ [OAUTH] Response received from Slack:");
    console.log(JSON.stringify(response, null, 2));

    if (!response.ok) {
      console.error("❌ [OAUTH] Slack returned an error:", response.error);
      return res.status(400).send(`<h3>Slack OAuth error: ${response.error}</h3>`);
    }

    const { access_token, team, bot_user_id } = response;
    console.log(`🧾 [OAUTH] Team ID: ${team.id}, Team Name: ${team.name}`);
    console.log(`🔑 [OAUTH] Access token (truncated): ${access_token.substring(0, 15)}...`);

    console.log("💾 [MONGO] Saving workspace info to DB...");
    await tokens.updateOne(
      { teamId: team.id },
      {
        $set: {
          teamId: team.id,
          teamName: team.name,
          accessToken: access_token,
          botUserId: bot_user_id,
          installedAt: new Date(),
        },
      },
      { upsert: true }
    );
    console.log("✅ [MONGO] Workspace saved to database.");

    res.send(`<h2>✅ Magic Hour Bot successfully installed to workspace: ${team.name}</h2>`);
  } catch (error) {
    console.error("❌ [OAUTH] Token exchange or DB save failed:");
    console.error(error);
    res.status(500).send(`<h3>Installation failed: ${error.message}</h3>`);
  }
});

// === HELPER: FETCH TEAM TOKEN ===
async function getToken(teamId) {
  console.log(`🔍 [TOKEN] Fetching token for teamId: ${teamId}`);
  const record = await tokens.findOne({ teamId });
  if (!record) {
    console.warn("⚠️ [TOKEN] No token found for teamId:", teamId);
    return null;
  }
  console.log("✅ [TOKEN] Token found for team:", record.teamName);
  return record.accessToken;
}

// === HELPER: GENERATE MEME ===
async function generateMeme(prompt) {
  console.log(`🎨 [Magic Hour] Requesting meme for prompt: "${prompt}"`);
  try {
    const result = await mh.v1.aiMemeGenerator.generate(
      {
        name: "Slack Meme Generation",
        style: { searchWeb: false, template: "Random", topic: prompt },
      },
      { waitForCompletion: true, downloadOutputs: false }
    );

    console.log("🧩 [Magic Hour] Full SDK result received:");
    console.log(JSON.stringify(result, null, 2));

    const memeUrl = result?.downloads?.[0]?.url || null;
    if (!memeUrl) throw new Error("No meme URL returned from MagicHour API");

    console.log(`✅ [Magic Hour] Meme ready: ${memeUrl}`);
    return memeUrl;
  } catch (err) {
    console.error("❌ [Magic Hour] Meme generation failed:", err.message);
    return null;
  }
}

// === SLACK EVENT LISTENER ===
app.event("app_mention", async ({ event }) => {
  console.log("🚀 [EVENT] app_mention triggered!");
  console.log(`🗣️ Text: "${event.text}" | User: ${event.user} | Team: ${event.team}`);

  const userPrompt = event.text.replace(/<@.*?>/g, "").trim();
  if (!userPrompt) {
    console.log("⚠️ [PROMPT] Empty user message. Ignoring.");
    return;
  }

  const token = await getToken(event.team);
  if (!token) {
    console.error("❌ [EVENT] No token found. Cannot reply.");
    return;
  }

  console.log("💬 [EVENT] Sending 'Generating meme...' message...");
  const tempMsg = await app.client.chat.postMessage({
    token,
    channel: event.channel,
    text: `🎨 Generating your meme, <@${event.user}>...`,
  });

  const memeUrl = await generateMeme(userPrompt);

  if (memeUrl) {
    console.log("✅ [EVENT] Meme generated successfully. Sending to Slack...");
    await app.client.chat.delete({ token, channel: event.channel, ts: tempMsg.ts });
    await app.client.chat.postMessage({
      token,
      channel: event.channel,
      text: `😂 Here's your meme, <@${event.user}>!`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `😂 Here's your meme, <@${event.user}>!` },
        },
        {
          type: "image",
          image_url: memeUrl,
          alt_text: "generated meme",
        },
      ],
    });
  } else {
    console.log("❌ [EVENT] Meme generation failed. Updating message...");
    await app.client.chat.update({
      token,
      channel: event.channel,
      ts: tempMsg.ts,
      text: "❌ Sorry, meme generation failed. Try again later.",
    });
  }
});

// === CRON JOB ===
cron.schedule("*/5 * * * *", async () => {
  console.log(`🕒 [CRON] Running scheduled auto-meme job: ${new Date().toLocaleString()}`);
  try {
    const teams = await tokens.find({}).toArray();
    console.log(`📊 [CRON] Found ${teams.length} installed teams.`);

    for (const team of teams) {
      console.log(`🔁 [CRON] Processing team: ${team.teamName} (${team.teamId})`);
      const token = team.accessToken;

      try {
        const result = await app.client.conversations.list({ token });
        const firstChannel = result.channels?.[0]?.id;
        if (!firstChannel) {
          console.warn(`⚠️ [CRON] No channels found for ${team.teamName}`);
          continue;
        }

        const messages = await app.client.conversations.history({
          token,
          channel: firstChannel,
          limit: 10,
        });

        const msg = messages.messages?.[0];
        if (!msg?.text) continue;

        const memeUrl = await generateMeme(`Based on: ${msg.text}`);
        if (memeUrl) {
          await app.client.chat.postMessage({
            token,
            channel: firstChannel,
            text: `🤣 Auto meme time in ${team.teamName}!`,
            attachments: [{ image_url: memeUrl, alt_text: "auto meme" }],
          });
        }
      } catch (err) {
        console.error(`❌ [CRON] Error for ${team.teamName}:`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ [CRON] Main loop failed:", err.message);
  }
});

// === STARTUP ===
(async () => {
  console.log("🚀 [INIT] Starting Magic Hour Slack Bot...");
  try {
    await connectMongo();
    await app.start(process.env.PORT || 3000);
    console.log(`⚡ [STARTUP] Magic Hour Slack Bot running on port ${process.env.PORT || 3000}`);

    const workspaceCount = await tokens.countDocuments();
    console.log(`📊 [INIT] Installed workspaces in DB: ${workspaceCount}`);
  } catch (err) {
    console.error("❌ [STARTUP ERROR]", err.message);
  }
})();
