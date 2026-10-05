import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getLeaderboard, getLevelingConfig, getXpForLevel } from '../../services/leveling/leveling.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('عرض قائمة المتصدرين للمستويات')
    .setDMPermission(false),

  category: 'Leveling',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);

    const levelingConfig = await getLevelingConfig(client, interaction.guildId);

    if (!levelingConfig?.enabled) {
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setColor('#f1c40f')
            .setDescription('نظام المستويات معطل حالياً في هذا السيرفر.')
        ],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const leaderboard = await getLeaderboard(client, interaction.guildId, 10);

    if (leaderboard.length === 0) {
      throw new TitanBotError(
        'No leaderboard data found',
        ErrorTypes.DATABASE,
        'لا توجد بيانات للمستويات حتى الآن. ابدأ بالمحادثة لتحصل على XP!'
      );
    }

    const embed = new EmbedBuilder()
      .setTitle('🏆 قائمة المتصدرين')
      .setColor('#2ecc71')
      .setDescription('أكثر 10 أعضاء نشاطاً في هذا السيرفر:')
      .setTimestamp();

    const leaderboardText = await Promise.all(
      leaderboard.map(async (user, index) => {
        try {
          const member = await interaction.guild.members
            .fetch(user.userId)
            .catch(() => null);

          const userMention = member?.user.toString() || `<@${user.userId}>`;
          const xpForNextLevel = getXpForLevel(user.level + 1);

          let rankPrefix = `${index + 1}.`;

          if (index === 0) rankPrefix = '🥇';
          else if (index === 1) rankPrefix = '🥈';
          else if (index === 2) rankPrefix = '🥉';
          else rankPrefix = `**${index + 1}.**`;

          return `${rankPrefix} ${userMention} - المستوى ${user.level} (${user.xp}/${xpForNextLevel} XP)`;
        } catch {
          return `**${index + 1}.** تعذر تحميل بيانات المستخدم ${user.userId}`;
        }
      })
    );

    embed.addFields({
      name: '📊 الترتيب',
      value: leaderboardText.join('\n')
    });

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [embed]
    });

    logger.debug(`Leaderboard displayed for guild ${interaction.guildId}`);
  }
};
