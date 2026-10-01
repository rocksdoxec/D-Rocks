import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { getColor } from '../../config/bot.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName("قفل")
        .setDescription(
            "قفل القناة الحالية ومنع الأعضاء من إرسال الرسائل."
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    category: "moderation",

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);

        if (!deferSuccess) {
            logger.warn(`Lock interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'lock'
            });
            return;
        }

        const channel = interaction.channel;
        const everyoneRole = interaction.guild.roles.everyone;

        try {
            const currentPermissions = channel.permissionsFor(everyoneRole);

            if (currentPermissions.has(PermissionFlagsBits.SendMessages) === false) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: `${channel} مقفلة بالفعل.`
                });
            }

            await channel.permissionOverwrites.edit(
                everyoneRole,
                { SendMessages: false },
                { type: 0, reason: `Channel locked by ${interaction.user.tag}` },
            );

            await logEvent({
                client,
                guild: interaction.guild,
                event: {
                    action: "Channel Locked",
                    target: channel.toString(),
                    executor: `${interaction.user.tag} (${interaction.user.id})`,
                    metadata: {
                        channelId: channel.id,
                        category: channel.parent?.name || 'None',
                        moderatorId: interaction.user.id
                    }
                }
            });

            // رسالة عادية بدل Embed
            await InteractionHelper.safeEditReply(interaction, {
                content: `🔒 **تم قفل القناة**\n${channel} تم قفلها الآن. لا يمكن لأحد إرسال رسائل هنا.`,
            });

        } catch (error) {
            logger.error('Lock command error:', error);

            await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'حدث خطأ أثناء محاولة قفل القناة. تأكد من أن لدي صلاحية **إدارة القنوات (Manage Channels)**.'
            });
        }
    }
};
