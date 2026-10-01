import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { sanitizeMarkdown } from '../../utils/validation.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName("dm")
        .setDescription("إرسال رسالة خاصة إلى عضو (للمشرفين فقط)")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("العضو الذي تريد إرسال رسالة خاصة إليه")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("message")
                .setDescription("الرسالة التي تريد إرسالها")
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option
                .setName("anonymous")
                .setDescription("إرسال الرسالة بشكل مجهول (الافتراضي: لا)")
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .setDMPermission(false),

    category: "moderation",

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`DM interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'dm'
            });
            return;
        }

        const targetUser = interaction.options.getUser("user");
        const message = interaction.options.getString("message");
        const anonymous = interaction.options.getBoolean("anonymous") || false;

        try {
            
            if (message.length > 2000) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'يجب أن تكون الرسالة أقل من 2000 حرف.'
                });
            }

            if (targetUser.bot) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'لا يمكنك إرسال رسائل خاصة إلى حسابات البوتات.'
                });
            }

            const sanitized = sanitizeMarkdown(message);

            const dmChannel = await targetUser.createDM();
            
            await dmChannel.send({
                embeds: [
                    successEmbed(
                        anonymous ? "رسالة من فريق الإدارة" : `رسالة من ${interaction.user.tag}`,
                        sanitized
                    ).setFooter({
                        text: `لا يمكنك الرد على هذه الرسالة. | رقم السجل: ${interaction.id}`
                    })
                ]
            });

            await logEvent({
                client: interaction.client,
                guild: interaction.guild,
                event: {
                    action: "DM Sent",
                    target: `${targetUser.tag} (${targetUser.id})`,
                    executor: `${interaction.user.tag} (${interaction.user.id})`,
                    reason: `Anonymous: ${anonymous ? 'Yes' : 'No'}`,
                    metadata: {
                        userId: targetUser.id,
                        moderatorId: interaction.user.id,
                        anonymous,
                        messageLength: sanitized.length
                    }
                }
            });

            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    successEmbed(
                        "تم إرسال الرسالة الخاصة",
                        `تم إرسال الرسالة بنجاح إلى ${targetUser.tag}`
                    ),
                ],
            });
        } catch (error) {
            logger.error('DM command error:', error);
            
            if (error.code === 50007) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: `تعذر إرسال رسالة خاصة إلى ${targetUser.tag}. ربما قام بتعطيل الرسائل الخاصة.`
                });
            }
            
            return await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: `فشل إرسال الرسالة الخاصة: ${error.message}`
            });
        }
    }
};
