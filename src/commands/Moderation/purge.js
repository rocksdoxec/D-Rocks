import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { getColor } from '../../config/bot.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName("purge")
        .setDescription("حذف عدد محدد من الرسائل")
        .addIntegerOption((option) =>
            option
                .setName("amount")
                .setDescription("عدد الرسائل (1-100)")
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    category: "moderation",

    abuseProtection: { maxAttempts: 5, windowMs: 60_000 },

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });

        if (!deferSuccess) {
            logger.warn(`Purge interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'purge'
            });
            return;
        }

        const amount = interaction.options.getInteger("amount");
        const channel = interaction.channel;

        if (amount < 1 || amount > 100) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'يرجى تحديد رقم بين 1 و100.'
            });
        }

        try {
            const fetched = await channel.messages.fetch({ limit: amount });
            const deleted = await channel.bulkDelete(fetched, true);
            const deletedCount = deleted.size;

            await logEvent({
                client,
                guild: interaction.guild,
                event: {
                    action: "Messages Purged",
                    target: `${channel} (${deletedCount} messages)`,
                    executor: `${interaction.user.tag} (${interaction.user.id})`,
                    reason: `Deleted ${deletedCount} messages`,
                    metadata: {
                        channelId: channel.id,
                        messageCount: deletedCount,
                        requestedAmount: amount,
                        moderatorId: interaction.user.id
                    }
                }
            });

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    successEmbed(
                        "تم حذف الرسائل",
                        `تم حذف ${deletedCount} رسالة من ${channel}.`,
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });

            // حذف رسالة النجاح تلقائياً بعد 3 ثواني
            setTimeout(() => {
                interaction.deleteReply().catch(err =>
                    logger.debug('Failed to auto-delete purge response:', err)
                );
            }, 3000);

        } catch (error) {
            logger.error('Purge command error:', error);

            await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'حدث خطأ غير متوقع أثناء حذف الرسائل. ملاحظة: لا يمكن حذف الرسائل التي مر عليها أكثر من 14 يومًا باستخدام الحذف الجماعي.'
            });
        }
    }
};
