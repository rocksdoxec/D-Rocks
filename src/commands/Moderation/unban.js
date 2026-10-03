import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { ModerationService } from '../../services/moderation/moderationService.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName("unban")
        .setDescription("إلغاء حظر عضو من السيرفر")
        .addStringOption(option =>
            option
                .setName("target")
                .setDescription("معرّف العضو أو منشن العضو الذي تريد إلغاء حظره")
                .setRequired(true),
        )
        .addStringOption(option =>
            option.setName("reason")
                .setDescription("سبب إلغاء الحظر")
                .setRequired(false),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    category: "moderation",

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Unban interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'unban',
            });
            return;
        }

        const rawTarget = interaction.options.getString("target");
        const targetId = rawTarget.replace(/[<@!>]/g, '').trim();

        if (!/^\d{17,20}$/.test(targetId)) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'يرجى إدخال معرّف عضو صالح أو منشن للعضو.',
            });
        }

        const targetUser = await client.users.fetch(targetId).catch(() => null);
        if (!targetUser) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: `تعذر العثور على عضو بالمعرّف \`${targetId}\`.`,
            });
        }

        const reason = interaction.options.getString("reason") || "لم يتم تحديد سبب";

        const result = await ModerationService.unbanUser({
            guild: interaction.guild,
            user: targetUser,
            moderator: interaction.member,
            reason,
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    "✅ تم إلغاء حظر العضو",
                    `تم إلغاء حظر **${targetUser.tag}** من السيرفر بنجاح.\n\n**السبب:** ${reason}\n**رقم الحالة:** #${result.caseId}`,
                ),
            ],
        });
    },
};
