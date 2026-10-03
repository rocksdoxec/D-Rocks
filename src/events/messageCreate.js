import { Events, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling/leveling.js';
import { addXp } from '../services/leveling/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commands/commandAliases.js';
import { getPrefixRestriction } from '../config/commands/prefixRestrictions.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
  getCommandPrefix,
  getBotMessage,
  isBotOwner,
  isCommandCategoryEnabled,
  isMaintenanceMode,
} from '../config/bot.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import {
  getCountingGameConfig,
  saveCountingGameConfig,
  isValidCountingMessage,
  recordCorrectCount,
} from '../services/countingGameService.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

// قناة تسجيل الرسائل الخاصة
const DM_LOG_CHANNEL_ID = '1555915387563016223';

export default {
  name: Events.MessageCreate,

  async execute(message, client) {
    try {
      // تجاهل رسائل البوتات
      if (message.author.bot) return;

      // إذا كانت الرسالة DM
if (!message.guild) {
  console.log('📩 DM RECEIVED:', message.author.tag, message.content);

  await handleDirectMessage(message, client);
  return;
}
      logger.debug(
        `Message received from ${message.author.tag}: ${message.content}`
      );

      const countingProcessed = await handleCountingGame(message, client);

      if (countingProcessed) {
        return;
      }

      await handlePrefixCommand(message, client);

      await handleLeveling(message, client);
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  }
};

async function handleDirectMessage(message, client) {
  try {
    const logChannel = await client.channels
      .fetch(DM_LOG_CHANNEL_ID)
      .catch(() => null);

    if (!logChannel || !logChannel.isTextBased()) {
      logger.warn(
        `DM log channel not found or is not text-based: ${DM_LOG_CHANNEL_ID}`
      );
      return;
    }

    const messageContent =
      message.content?.trim() || '*رسالة بدون نص*';

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('✉️ رسالة خاصة جديدة')
      .setAuthor({
        name: message.author.tag,
        iconURL: message.author.displayAvatarURL({ size: 128 }),
      })
      .addFields(
        {
          name: '👤 المستخدم',
          value: `${message.author}\n\`${message.author.id}\``,
          inline: false,
        },
        {
          name: '💬 الرسالة',
          value:
            messageContent.length > 4000
              ? `${messageContent.slice(0, 3997)}...`
              : messageContent,
          inline: false,
        }
      )
      .setTimestamp()
      .setFooter({
        text: `User ID: ${message.author.id}`,
      });

    // إذا كانت الرسالة تحتوي على مرفقات
    if (message.attachments.size > 0) {
      const attachments = message.attachments
        .map((attachment) => `[${attachment.name || 'مرفق'}](${attachment.url})`)
        .join('\n');

      embed.addFields({
        name: '📎 المرفقات',
        value: attachments.slice(0, 1024),
        inline: false,
      });
    }

    await logChannel.send({
      embeds: [embed],
    });

    logger.info(
      `DM logged from ${message.author.tag} (${message.author.id})`
    );
  } catch (error) {
    logger.error('Error logging direct message:', error);
  }
}

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = '#';
    const parsed = parsePrefixCommand(message.content, prefix);

    if (!parsed) {
      return;
    }

    let { commandName, args } = parsed;

    const musicPrefixShortcut = commandName.toLowerCase();

    const MUSIC_PREFIX_SHORTCUTS = new Set([
      'leave',
      'pause',
      'resume',
      'skip',
      'stop',
      'volume',
    ]);

    if (MUSIC_PREFIX_SHORTCUTS.has(musicPrefixShortcut)) {
      commandName = 'music';
      args = [musicPrefixShortcut, ...args];
    }

    logger.info(
      `Prefix command detected: ${commandName}, args: ${args.join(', ')}`
    );

    const resolvedCommandName = resolveCommandAlias(commandName);

    logger.info(`Resolved command name: ${resolvedCommandName}`);

    const command = client.commands.get(resolvedCommandName);

    if (!command) {
      logger.warn(`Command not found: ${resolvedCommandName}`);
      return;
    }

    if (isMaintenanceMode() && !isBotOwner(message.author.id)) {
      await message.channel.send({
        embeds: [
          createEmbed({
            title: 'Maintenance Mode',
            description: getBotMessage('maintenanceMode'),
            color: 'warning',
          }),
        ],
      }).catch(() => {});

      return;
    }

    if (!isCommandCategoryEnabled(command.category)) {
      await message.channel.send({
        embeds: [
          createEmbed({
            title: 'Feature Disabled',
            description: getBotMessage('commandDisabled'),
            color: 'error',
          }),
        ],
      }).catch(() => {});

      return;
    }

    const restriction = getPrefixRestriction(
      command,
      args,
      resolveSubcommandAlias
    );

    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        const embed = createEmbed({
          title: 'Slash Command Only',
          description:
            `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,
          color: 'info',
        });

        await message.channel.send({
          embeds: [embed],
        }).catch(() => {});
      }

      return;
    }

    if (
      !(await isCommandEnabled(
        client,
        message.guild.id,
        resolvePrefixAccessKey(command.data, args),
        command.category
      ))
    ) {
      const embed = createEmbed({
        title: 'Command Disabled',
        description: 'This command has been disabled for this server.',
        color: 'error',
      });

      await message.channel.send({
        embeds: [embed],
      }).catch(() => {});

      return;
    }

    logger.info(
      `Executing prefix command: ${prefix}${commandName} ` +
      `(resolved to ${resolvedCommandName}) by ${message.author.tag}`
    );

    await executePrefixCommand(
      command,
      message,
      args,
      client,
      prefix,
      guildConfig
    );
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(
      client,
      message.guild.id
    );

    if (
      !config.enabled ||
      !config.channelId ||
      message.channel.id !== config.channelId
    ) {
      return false;
    }

    const content = message.content.trim();

    const validCount = isValidCountingMessage(
      content,
      config
    );

    const invalidAttempt =
      !validCount ||
      message.author.id === config.lastUserId;

    if (invalidAttempt) {
      await message.delete().catch(() => {});

      await saveCountingGameConfig(client, message.guild.id, {
        ...config,
        nextNumber: 1,
        lastUserId: null,
        currentStreak: 0,
      });

      const failureMessage = await message.channel.send(
        `❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`
      );

      setTimeout(() => {
        failureMessage.delete().catch(() => {});
      }, 10000);

      return true;
    }

    await recordCorrectCount(
      client,
      message.guild.id,
      message.author.id
    );

    return true;
  } catch (error) {
    logger.error('Error handling counting game:', error);
    return false;
  }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey =
      `xp-event:${message.guild.id}:${message.author.id}`;

    const canProcess = await checkRateLimit(
      rateLimitKey,
      MESSAGE_XP_RATE_LIMIT_ATTEMPTS,
      MESSAGE_XP_RATE_LIMIT_WINDOW_MS
    );

    if (!canProcess) {
      return;
    }

    const levelingConfig = await getLevelingConfig(
      client,
      message.guild.id
    );

    if (!levelingConfig?.enabled) {
      return;
    }

    if (
      levelingConfig.ignoredChannels?.includes(
        message.channel.id
      )
    ) {
      return;
    }

    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members
        .fetch(message.author.id)
        .catch(() => null);

      if (
        member &&
        member.roles.cache.some((role) =>
          levelingConfig.ignoredRoles.includes(role.id)
        )
      ) {
        return;
      }
    }

    if (
      levelingConfig.blacklistedUsers?.includes(
        message.author.id
      )
    ) {
      return;
    }

    if (
      !message.content ||
      message.content.trim().length === 0
    ) {
      return;
    }

    const userData = await getUserLevelData(
      client,
      message.guild.id,
      message.author.id
    );

    const cooldownTime =
      levelingConfig.xpCooldown || 60;

    const now = Date.now();

    const timeSinceLastMessage =
      now - (userData.lastMessage || 0);

    if (
      timeSinceLastMessage <
      cooldownTime * 1000
    ) {
      return;
    }

    const minXP =
      levelingConfig.xpRange?.min ||
      levelingConfig.xpPerMessage?.min ||
      15;

    const maxXP =
      levelingConfig.xpRange?.max ||
      levelingConfig.xpPerMessage?.max ||
      25;

    const safeMinXP = Math.max(1, minXP);

    const safeMaxXP = Math.max(
      safeMinXP,
      maxXP
    );

    const xpToGive =
      Math.floor(
        Math.random() *
        (safeMaxXP - safeMinXP + 1)
      ) + safeMinXP;

    let finalXP = xpToGive;

    if (
      levelingConfig.xpMultiplier &&
      levelingConfig.xpMultiplier > 1
    ) {
      finalXP = Math.floor(
        finalXP *
        levelingConfig.xpMultiplier
      );
    }

    const result = await addXp(
      client,
      message.guild,
      message.member,
      finalXP
    );

    if (result?.leveledUp) {
      logger.info(
        `${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`
      );
    }
  } catch (error) {
    logger.error(
      'Error handling leveling for message:',
      error
    );
  }
}
