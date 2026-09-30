import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js'; 
import { successEmbed } from '../../utils/embeds.js'; 
import { InteractionHelper } from '../../utils/interactionHelper.js'; 
import { ModerationService } from '../../services/moderation/moderationService.js'; 
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js'; 
 
export default { 
    data: new SlashCommandBuilder() 
        .setName("ban") 
        .setDescription("حظر عضو من السيرفر") 
        .addUserOption((option) => 
            option 
                .setName("target") 
                .setDescription("العضو الذي تريد حظره") 
                .setRequired(true), 
        ) 
        .addStringOption((option) => 
            option.setName("reason").setDescription("سبب الحظر"), 
        ) 
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers), 
    category: "moderation", 
 
    async execute(interaction, config, client) { 
        const user = interaction.options.getUser("target"); 
        const reason = interaction.options.getString("reason") || "لم يتم تحديد سبب"; 
 
        if (!user) { 
            throw new TitanBotError( 
                'العضو غير موجود', 
                ErrorTypes.USER_INPUT, 
                'يجب عليك تحديد عضو لحظره.', 
                { subtype: 'invalid_user' }, 
            ); 
        } 
 
        if (user.id === interaction.user.id) { 
            throw new TitanBotError( 
                'لا يمكن حظر نفسك', 
                ErrorTypes.VALIDATION, 
                'لا يمكنك حظر نفسك.', 
            ); 
        } 
        if (user.id === client.user.id) { 
            throw new TitanBotError( 
                'لا يمكن حظر البوت', 
                ErrorTypes.VALIDATION, 
                'لا يمكنك حظر البوت.', 
            ); 
        } 
 
        const result = await ModerationService.banUser({ 
            guild: interaction.guild, 
            user, 
            moderator: interaction.member, 
            reason, 
        }); 
 
        await InteractionHelper.universalReply(interaction, { 
            embeds: [ 
                successEmbed( 
                    `🚫 **تم حظر** ${user.tag}`, 
                    `**السبب:** ${reason}\n**رقم الحالة:** #${result.caseId}`, 
                ), 
            ], 
        }); 
    }, 
};
