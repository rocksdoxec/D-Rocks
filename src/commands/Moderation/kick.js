import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ModerationService } from '../../services/moderation/moderationService.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        .setName("kick")
        .setDescription("طرد عضو من السيرفر")
        .addUserOption((option) =>
            option
                .setName("target")
                .setDescription("العضو الذي تريد طرده")
                .setRequired(true),
        )
        .addStringOption((option) =>
            option.setName("reason").setDescription("سبب الطرد"),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    category: "moderation",

    async execute(interaction, config, client) {
        const targetUser = interaction.options.getUser("target");
        const member = interaction.options.getMember("target");
        const reason = interaction.options.getString("reason") || "لم يتم تحديد سبب";

        if (!targetUser) {
            throw new TitanBotError(
                'العضو غير موجود',
                ErrorTypes.USER_INPUT,
                'يجب عليك تحديد عضو لطرده.',
                { subtype: 'invalid_user' },
            );
        }

        if (targetUser.id === interaction.user.id) {
            throw new TitanBotError(
                "لا يمكن طرد نفسك",
                ErrorTypes.VALIDATION,
                "لا يمكنك طرد نفسك.",
            );
        }

        if (targetUser.id === client.user.id) {
            throw new TitanBotError(
                "لا يمكن طرد البوت",
                ErrorTypes.VALIDATION,
                "لا يمكنك طرد البوت.",
            );
        }

        if (!member) {
            throw new TitanBotError(
                "العضو غير موجود",
                ErrorTypes.USER_INPUT,
                "العضو المحدد ليس موجودًا حاليًا في هذا السيرفر.",
                { subtype: 'user_not_found' },
            );
        }

        const result = await ModerationService.kickUser({
            guild: interaction.guild,
            member,
            moderator: interaction.member,
            reason,
        });

        await InteractionHelper.universalReply(interaction, {
            embeds: [
                successEmbed(
                    `✈️ **تم طرد** ${targetUser.tag}`,
                    `**السبب:** ${reason}\n**رقم الحالة:** #${result.caseId}`,
                ),
            ],
        });
    },
};
