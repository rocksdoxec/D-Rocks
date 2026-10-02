import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { getColor } from '../../config/bot.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName("clear")
        .setDescription("حذف عدد محدد من الرسائل")
        .addIntegerOption((option) =>
            option
                .setName("amount")
                .setDescription("عدد الرسائل (1-1000)")
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    category: "moderation",

   abuseProtection: { maxAttempts: 1, windowMs: 3_000 },

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });

        if (!deferSuccess) {
            logger.warn(`Clear interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'clear'
            });
            return;
        }

        const amount = interaction.options.getInteger("amount");
        const channel = interaction.channel;

        if (amount < 1 || amount > 1000) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'يرجى تحديد رقم بين 1 و1000.'
            });
        }

        try {
            let remaining = amount;
            let deletedCount = 0;

            while (remaining > 0) {
                const batchSize = Math.min(remaining, 100);

                const fetched = await channel.messages.fetch({
                    limit: batchSize
                });

                if (fetched.size === 0) {
                    break;
                }

                const deleted = await channel.bulkDelete(fetched, true);
                deletedCount += deleted.size;
                remaining -= deleted.size;

                // إذا لم يتم حذف أي رسالة، نتوقف حتى لا ندخل في حلقة لا نهائية
                if (deleted.size === 0) {
                    break;
                }

                // توقف بسيط بين الدفعات لتجنب الضغط على Discord API
                if (remaining > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            await logEvent({
                client,
                guild: interaction.guild,
                event: {
                    action: "Messages Cleared",
                    target: `${channel} (${deletedCount} messages)`,
                    executor: `${interaction.user.tag} (${interaction.user.id})`,
                    reason: `Cleared ${deletedCount} messages`,
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
                    logger.debug('Failed to auto-delete clear response:', err)
                );
            }, 3000);

        } catch (error) {
            logger.error('Clear command error:', error);

            await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'حدث خطأ غير متوقع أثناء حذف الرسائل. ملاحظة: لا يمكن حذف الرسائل التي مر عليها أكثر من 14 يومًا باستخدام الحذف الجماعي.'
            });
        }
    }
};
