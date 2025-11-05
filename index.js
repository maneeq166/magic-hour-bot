require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const cron = require("node-cron");
const express = require("express");
const MagicHourImport = require("magic-hour");

// === Initialize Magic Hour SDK ===
const MagicHour = MagicHourImport.default || MagicHourImport;
const mh = new MagicHour({ token: process.env.MH_API_KEY });

// === EXPRESS RECEIVER FOR SLACK EVENTS ===
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// === EXPRESS SERVER REFERENCE ===
const server = receiver.app;

// === SLACK APP INITIALIZATION ===
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// === TEMPORARY IN-MEMORY CHANNEL STORE ===
const channelMap = new Map(); // teamId -> [channelIds]

// === HEALTH CHECK ENDPOINT ===
server.get("/", (req, res) => {
  res.send("✅ Magic Hour Slack Bot is up and running!");
});

// === LOG EVERY SLACK EVENT FOR DEBUGGING ===
app.event(/.*/, async ({ event }) => {
  console.log(`📩 [EVENT] Type: ${event.type}`);
  if (event.text) console.log(`🗣️  Message Text: "${event.text}"`);
  if (event.user) console.log(`👤 From User: ${event.user}`);
  if (event.channel) console.log(`💬 In Channel: ${event.channel}`);
});

// === HELPER: Generate Meme Using Magic Hour SDK ===
async function generateMeme(prompt) {
  console.log(`🎨 [Magic Hour] Generating meme for prompt: "${prompt}"`);

  try {
    const result = await mh.v1.aiMemeGenerator.generate(
      {
        name: "Slack Meme Generation",
        style: {
          searchWeb: false,
          template: "Random",
          topic: prompt,
        },
      },
      { waitForCompletion: true, downloadOutputs: false }
    );

    console.log("🧩 [Magic Hour] Full SDK Response:", JSON.stringify(result, null, 2));

    const memeUrl =
      result?.downloads?.[0]?.url ||
      result?.downloadedPaths?.[0] ||
      null;

    if (!memeUrl) throw new Error("No meme URL returned from Magic Hour SDK");
    console.log(`✅ [Magic Hour] Meme generated successfully: ${memeUrl}`);
    return memeUrl;
  } catch (err) {
    console.error("❌ [Magic Hour] SDK Error generating meme:", err.message);
    return null;
  }
}

// === HELPER: Find Most Engaging Message ===
async function findEngagingMessage(messages) {
  console.log("🔍 [Find Engaging] Evaluating recent messages...");
  let top = null;
  let maxScore = 0;

  for (const msg of messages) {
    const reactionScore = msg.reactions?.reduce((s, r) => s + (r.count || 0), 0) || 0;
    const lengthScore = (msg.text?.length || 0) / 10;
    const score = reactionScore + lengthScore;

    console.log(`💬 Message: "${msg.text?.substring(0, 50)}..." | Score: ${score}`);

    if (score > maxScore) {
      maxScore = score;
      top = msg;
    }
  }

  console.log(top ? `🏆 [Find Engaging] Selected: "${top.text}"` : "⚠️ No engaging message found.");
  return top;
}

// === COMMAND: setchannel ===
app.message(/^setchannel/i, async ({ message, say }) => {
  console.log(`⚙️ [Command] 'setchannel' called in team ${message.team}, channel ${message.channel}`);

  const teamId = message.team;
  const existing = channelMap.get(teamId) || [];

  if (!existing.includes(message.channel)) existing.push(message.channel);
  channelMap.set(teamId, existing);

  await say(`✅ This channel (<#${message.channel}>) is now set for Magic Hour auto memes.`);
  console.log(`📌 [Channel Added] ${message.channel} saved for team ${teamId}`);
});

// === LISTEN FOR "@Magic hour ..." (no need to type 'create meme') ===
app.event("app_mention", async ({ event, say }) => {
  console.log(`🚀 [Mention Detected] Text: "${event.text}" from ${event.user}`);

  const text = event.text || "";

  // Remove bot mention (like <@U12345>)
  const userPrompt = text.replace(/<@.*?>/g, "").trim();

  if (!userPrompt) {
    console.log("⚠️ [Mention Invalid] Empty meme prompt.");
    await say("❌ Please type something after tagging me, e.g. `@Magic hour when code finally works`");
    return;
  }

  console.log(`🧠 [Prompt Extracted] "${userPrompt}"`);

  // Send temporary "Generating..." message and store its timestamp (ts)
  const generatingMsg = await app.client.chat.postMessage({
    channel: event.channel,
    text: `🎨 Generating your meme, <@${event.user}>...`,
  });

  const tempMsgTs = generatingMsg.ts;

  // Generate meme
  const memeUrl = await generateMeme(userPrompt);

  if (memeUrl) {
    // Delete the "Generating..." message
    await app.client.chat.delete({
      channel: event.channel,
      ts: tempMsgTs,
    });

    // Post the final meme
    await app.client.chat.postMessage({
      channel: event.channel,
      text: `😂 Here's your meme, <@${event.user}>!`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `😂 Here's your meme, <@${event.user}>!`,
          },
        },
        {
          type: "image",
          image_url: memeUrl,
          alt_text: "generated meme",
        },
      ],
    });

    console.log(`✅ [Manual Meme] Sent meme to ${event.user}`);
  } else {
    // Update the message instead of deleting, to show error
    await app.client.chat.update({
      channel: event.channel,
      ts: tempMsgTs,
      text: "❌ Sorry, couldn't generate meme. Try again later.",
    });

    console.error(`❌ [Manual Meme] Failed for user ${event.user}`);
  }
});




// === CRON JOB: AUTO MEMES EVERY 2 HOURS ===
// For testing: use "*/1 * * * *" (every 1 minute)
cron.schedule("0 */2 * * *", async () => {
  console.log(`🕒 [CRON] Running auto meme job at ${new Date().toLocaleTimeString()}`);

  for (const [team, channels] of channelMap.entries()) {
    for (const channel of channels) {
      try {
        console.log(`📡 [CRON] Fetching messages for team: ${team}, channel: ${channel}`);
        const result = await app.client.conversations.history({
          token: process.env.SLACK_BOT_TOKEN,
          channel,
          limit: 50,
        });

        const engaging = await findEngagingMessage(result.messages);
        if (!engaging) {
          console.log("⚠️ [CRON] No engaging message found.");
          continue;
        }

        const author = engaging.user;
        const content = engaging.text;
        console.log(`✨ [CRON] Selected message: "${content}" by user ${author}`);

        const memeUrl = await generateMeme(`Make a funny meme based on: "${content}"`);

        if (memeUrl) {
          await app.client.chat.postMessage({
            channel,
            text: `🤣 Auto Meme Time! <@${author}> (Based on: "${content.substring(0, 50)}...")`,
            attachments: [{ image_url: memeUrl, alt_text: "meme" }],
          });
          console.log(`✅ [CRON] Meme posted successfully in ${channel}`);
        } else {
          console.error(`❌ [CRON] Meme generation failed for channel ${channel}`);
        }
      } catch (err) {
        console.error("❌ [CRON] Error in auto meme job:", err.message);
      }
    }
  }
});

// === START SLACK APP ===
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡ Magic Hour Slack Bot is running on port " + (process.env.PORT || 3000));
  console.log("✅ Express health check: http://localhost:" + (process.env.PORT || 3000));
})();
