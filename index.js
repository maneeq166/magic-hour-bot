require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const cron = require("node-cron");
const MagicHourImport = require("magic-hour");

// Resolve the MagicHour constructor, checking for the common .default export when using require()
const MagicHour = MagicHourImport.default || MagicHourImport; 

// Initialize Magic Hour API client
// IMPORTANT: Assumes MH_API_KEY is correct in .env
const mh = new MagicHour({ token: process.env.MH_API_KEY });

// Initialize Discord Client
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

const BOT_COMMAND_PREFIX = "create meme";

discord.once("ready", () => {
  console.log(`✅ Logged in as ${discord.user.tag}`);
  // Set the bot's activity status
  discord.user.setActivity(
    `Use @${discord.user.username} ${BOT_COMMAND_PREFIX}`
  );
});

/**
 * Generates content (meme/image) using the Magic Hour AI Meme Generator.
 * @param {string} prompt - The creative prompt for the content.
 * @returns {Promise<string|null>} The URL of the generated content, or null on failure.
 */
async function generateContent(prompt) {
  const startTime = Date.now();
  console.log(
    `[${new Date().toLocaleTimeString()}] ➡️ Attempting to generate content for prompt: "${prompt.substring(
      0,
      30
    )}..."`
  );

  try {
    // Using the aiMemeGenerator as requested, with 'topic' and 'template'
    const result = await mh.v1.aiMemeGenerator.generate(
      {
        // Parameters for the generation job
        name: "Discord Meme Generation",
        style: {
          searchWeb: false,
          template: "Random", // Uses a random meme template format
          topic: prompt, // The prompt is passed as the topic/idea
        },
      },
      {
        // Options for the SDK wrapper function
        waitForCompletion: true,
        downloadOutputs: false, // We only need the URL
      }
    );

    // Check if the generation was successful and has outputs
    if (
      result.status === "complete" &&
      result.downloads &&
      result.downloads.length > 0
    ) {
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[${new Date().toLocaleTimeString()}] 🎉 Job ${
          result.id
        } completed! Total time: ${totalTime}s.`
      );
      return result.downloads[0].url;
    } else {
      // Log detailed error from the API side if status is 'error'
      const errorDetails = result.error
        ? result.error.message
        : "No detailed error provided.";
      console.error(
        `[${new Date().toLocaleTimeString()}] ❌ Job failed. Final Status: ${
          result.status
        }. Error: ${errorDetails}`
      );
      return null;
    }
  } catch (err) {
    // Catches network errors or immediate API key/quota rejections
    console.error(
      `[${new Date().toLocaleTimeString()}] 🛑 FATAL ERROR DURING CONTENT GENERATION. Check API key/Quota.`
    );
    // Log the actual exception/message from the SDK
    console.error("❌ Full Error Object/Message:", err.message || err);
    return null;
  }
}

/**
 * Finds the most engaging message in the last 50, based on total reaction count.
 * @param {Channel} channel - The Discord channel object.
 * @returns {Promise<Message|null>} The most engaging message, or null.
 */
async function findMostEngagingMessage(channel) {
  try {
    // Fetch the last 50 messages
    const messages = await channel.messages.fetch({ limit: 50 });
    let mostEngaging = null;
    let maxReactions = -1;

    for (const message of messages.values()) {
      // Ignore bot messages
      if (message.author.bot) continue;

      let totalReactions = 0;
      // Sum up the counts of all unique reactions on the message
      message.reactions.cache.forEach((reaction) => {
        totalReactions += reaction.count;
      });

      // If this message has more reactions than the current max, it's the new favorite
      if (totalReactions > maxReactions) {
        maxReactions = totalReactions;
        mostEngaging = message;
      }
    }

    // Fallback: If no messages had reactions, just return the most recent non-bot message
    if (!mostEngaging && messages.size > 0) {
      return messages.find((m) => !m.author.bot) || null;
    }

    return mostEngaging;
  } catch (error) {
    console.error("❌ Error fetching messages for engaging content:", error);
    return null;
  }
}

// --- 1. RESPOND TO USER PROMPTS ---
discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Check if the bot was mentioned
  if (message.mentions.has(discord.user)) {
    // FIX: Get the clean content string and safely remove the first word (the resolved mention).
    let contentArray = message.cleanContent.trim().split(/\s+/);

    // Safely shift the first element (the mention itself, e.g., "@MagicHourAI")
    if (contentArray.length > 0 && contentArray[0].startsWith("@")) {
      contentArray.shift();
    }

    // Rejoin the remaining words to get the clean command/prompt string
    const content = contentArray.join(" ").trim();

    // Check for the specific command: "create meme <prompt>"
    if (content.toLowerCase().startsWith(BOT_COMMAND_PREFIX)) {
      const prompt = content.substring(BOT_COMMAND_PREFIX.length).trim();

      if (!prompt) {
        return message.reply(
          `Please provide a meme idea after the command, like: \`@${discord.user.username} ${BOT_COMMAND_PREFIX} when the database finally compiles\``
        );
      }

      // 1. Send immediate reply to confirm receipt
      await message.reply("🎨 Generating your meme... hang tight!");
      console.log(`🤖 Generating user-requested meme for: ${prompt}`);

      const memeUrl = await generateContent(prompt);

      if (memeUrl) {
        // 2. Send the result
        await message.reply({
          content: `😂 Hey ${message.author}! Here’s the content you requested based on: **${prompt}**`,
          files: [memeUrl],
        });
      } else {
        // 3. Send failure notice
        await message.reply(
          "❌ **Content generation failed.** This could be due to an invalid API Key/Quota, or the prompt was rejected by the AI."
        );
      }
    } else {
        // Log if the command was missed due to incorrect prefix (e.g., "create me a meme")
        console.log(
          `[${new Date().toLocaleTimeString()}] ⚠️ Message content did not match prefix: "${content.substring(
            0,
            50
          )}..."`
        );
    }
  }
});

// --- 2. AUTOMATIC CONTENT EVERY 2 HOURS (PRODUCTION) ---
// Cron expression: "0 */2 * * *" means "At minute 0 of every 2nd hour."
cron.schedule("0 */2 * * *", async () => {
  console.log(
    `[${new Date().toLocaleTimeString()}] 🕰️ Running 2-hour auto-content task...`
  );
  try {
    const channelId = process.env.CHANNEL_ID;
    if (!channelId) {
      return console.error(
        "❌ CHANNEL_ID is not defined in .env, skipping auto-content generation."
      );
    }

    const channel = await discord.channels.fetch(channelId);

    // 1. Identify the funniest or most engaging chat
    const engagingMessage = await findMostEngagingMessage(channel);

    if (engagingMessage) {
      const author = engagingMessage.author;
      const messageContent = engagingMessage.content;

      // Construct a contextual prompt for the AI based on the engaging chat
      const contentPrompt = `Create a humorous meme based on this recent server chat: "${messageContent}".`;

      console.log(
        `[${new Date().toLocaleTimeString()}] 🔥 Found engaging message by ${
          author.username
        }. Generating auto-content...`
      );

      const memeUrl = await generateContent(contentPrompt);

      if (memeUrl) {
        // Send the content, tagging the original author
        await channel.send({
          content: `🤣 **Auto Content Time!** This one's for you, ${author}! (Based on your engaging chat: *${messageContent.substring(
            0,
            50
          )}...*)`,
          files: [memeUrl],
        });
        console.log(
          `[${new Date().toLocaleTimeString()}] ✅ Auto-content posted in channel ${
            channel.name
          }.`
        );
      } else {
        console.error("❌ Failed to generate auto-content.");
      }
    } else {
      console.log(
        "ℹ️ Could not find an engaging non-bot message in the last 50."
      );
      // Fallback: Post a generic server joke if no message context is found
      const memeUrl = await generateContent(
        "something funny for a discord server that is full of coders and gamers"
      );
      if (memeUrl) {
        await channel.send({
          content: "😂 Auto Content Time! Here's a generic joke for the server.",
          files: [memeUrl],
        });
      }
    }
  } catch (err) {
    console.error("❌ Auto content error:", err);
  }
});

discord.login(process.env.DISCORD_TOKEN);
