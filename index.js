require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const cron = require("node-cron");
const MagicHourImport = require("magic-hour");

// Resolve the MagicHour constructor, checking for the common .default export when using require()
const MagicHour = MagicHourImport.default || MagicHourImport; 

// Initialize Magic Hour API client
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
  discord.user.setActivity(`Use @${discord.user.username} ${BOT_COMMAND_PREFIX}`);
});

/**
 * Generates a meme using the Magic Hour AI Meme Generator.
 * Polls the job status until it's complete or fails.
 * @param {string} prompt - The creative prompt for the meme.
 * @returns {Promise<string|null>} The URL of the generated meme, or null on failure.
 */
async function generateMeme(prompt) {
  const startTime = Date.now();
  console.log(`[${new Date().toLocaleTimeString()}] ➡️ Attempting to create Magic Hour job for prompt: "${prompt.substring(0, 30)}..."`);
  
  try {
    // 💡 FIX: Including 'prompt' inside the style object for maximum compatibility
    const job = await mh.v1.aiMemeGenerator.create({
      prompt, // Retain the top-level prompt just in case
      name: "Discord Meme",
      style: {
          prompt: prompt, // <-- NEW: Added prompt inside style object
          aspectRatio: "16:9",
          mood: "humorous",
          model: "gemini-2.5-flash-meme",
      }
    });
    
    console.log(`[${new Date().toLocaleTimeString()}] ✅ Job created successfully. ID: ${job.id}. Starting 3-second polling loop.`);


    let status = job.status;
    let attempts = 0;
    const maxAttempts = 20; // 60 seconds total wait time

    while (status !== "complete" && status !== "error" && attempts < maxAttempts) {
      attempts++;
      
      // 💡 Polling for job status
      const current = await mh.v1.aiMemeGenerator.get({ id: job.id });
      status = current.status;
      
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${new Date().toLocaleTimeString()}] 🔄 [Attempt ${attempts} / ${maxAttempts}] Polling ID ${job.id}. Status: **${status}**. Elapsed: ${elapsedSeconds}s`);


      if (status === "complete" && current.downloads.length > 0) {
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${new Date().toLocaleTimeString()}] 🎉 Meme job ${job.id} completed! Total time: ${totalTime}s.`);
        return current.downloads[0].url;
      }
      
      await new Promise((r) => setTimeout(r, 3000)); // Wait 3 seconds
    }
    
    // Log final status if it was not complete
    if (status === "error") {
        console.error(`[${new Date().toLocaleTimeString()}] ❌ Job ${job.id} failed. API reported error status.`);
        // Optional: console.error("API Response Details:", current); // Uncomment if you want full error object
    } else if (attempts >= maxAttempts) {
        console.error(`[${new Date().toLocaleTimeString()}] ❌ Job ${job.id} timed out after 60 seconds.`);
    } else {
        console.error(`[${new Date().toLocaleTimeString()}] ❌ Job ${job.id} failed with unexpected status: ${status}.`);
    }

    return null;

  } catch (err) {
    // This catches errors during the initial 'create' call (e.g., bad API key, Zod error, network error)
    console.error(`[${new Date().toLocaleTimeString()}] 🛑 FATAL ERROR DURING JOB CREATION.`);
    console.error("❌ Full Error Object:", err);
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
            message.reactions.cache.forEach(reaction => {
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
            return messages.find(m => !m.author.bot) || null;
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
    // Remove the mention part from the message content
    const content = message.content.replace(/<@!?(\d+)>/, "").trim();

    // Check for the specific command: "create meme <prompt>"
    if (content.toLowerCase().startsWith(BOT_COMMAND_PREFIX)) {
      const prompt = content.substring(BOT_COMMAND_PREFIX.length).trim();

      if (!prompt) {
        return message.reply(`Please provide a meme idea after the command, like: \`@${discord.user.username} ${BOT_COMMAND_PREFIX} when the database finally compiles\``);
      }

      await message.reply("🎨 Generating your meme... hang tight!");
      console.log(`🤖 Generating user-requested meme for: ${prompt}`);

      const memeUrl = await generateMeme(prompt);

      if (memeUrl) {
        // Tag the user and send the generated meme
        await message.reply({ 
            content: `😂 Hey ${message.author}! Here’s the meme you requested based on: **${prompt}**`, 
            files: [memeUrl] 
        });
      } else {
        await message.reply("❌ Failed to generate meme. The prompt might be too complex or the service timed out.");
      }
    }
  }
});


// --- 2. AUTOMATIC CONTENT EVERY 2 HOURS ---
// Cron expression: "0 */2 * * *" means "At minute 0 of every 2nd hour."
cron.schedule("0 */2 * * *", async () => {
  console.log(`[${new Date().toLocaleTimeString()}] 🕰️ Running 2-hour auto-meme generation task...`);
  try {
    const channelId = process.env.CHANNEL_ID;
    if (!channelId) {
        return console.error("❌ CHANNEL_ID is not defined in .env, skipping auto-meme.");
    }
    
    const channel = await discord.channels.fetch(channelId);

    // 1. Identify the funniest or most engaging chat
    const engagingMessage = await findMostEngagingMessage(channel);

    if (engagingMessage) {
        const author = engagingMessage.author;
        const messageContent = engagingMessage.content;
        
        // Construct a contextual prompt for the AI based on the engaging chat
        const memePrompt = `Create a humorous image/meme based on this recent server chat: "${messageContent}". Tag the user ${author.username}.`;

        console.log(`[${new Date().toLocaleTimeString()}] 🔥 Found engaging message by ${author.username}. Generating auto-meme...`);
        
        const memeUrl = await generateMeme(memePrompt);

        if (memeUrl) {
          // Send the meme, tagging the original author
          await channel.send({ 
              content: `🤣 **Auto Meme Time!** This one's for you, ${author}! (Based on your recent engaging chat: *${messageContent.substring(0, 50)}...*)`, 
              files: [memeUrl] 
          });
          console.log(`[${new Date().toLocaleTimeString()}] ✅ Auto-meme posted in channel ${channel.name}.`);
        } else {
            console.error("❌ Failed to generate auto-meme.");
        }
    } else {
        console.log("ℹ️ Could not find an engaging non-bot message in the last 50.");
        // Fallback: Post a generic server joke if no message context is found
        const memeUrl = await generateMeme("something funny for a discord server that is full of coders and gamers");
        if (memeUrl) {
             await channel.send({ content: "😂 Auto meme time! Here's a generic joke for the server.", files: [memeUrl] });
        }
    }
  } catch (err) {
    console.error("❌ Auto meme error:", err);
  }
});

discord.login(process.env.DISCORD_TOKEN);
