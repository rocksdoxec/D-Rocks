import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logModerationAction } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { ModerationService } from '../../services/moderation/moderationService.js';
import { TitanBotError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName("masskick")
        .setDescription("طرد عدة أعضاء من السيرفر في نفس الوقت")
        .addStringOption(option =>
            option
                .setName("users")
                .setDescription("معرفات الأعضاء أو المنشنات المراد طردها (افصل بينها بمسافات أو فواصل)")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("سبب الطرد الجماعي")
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    category: "moderation",

    abuseProtection: { maxAttempts: 3, windowMs: 60_000 },

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);

        if (!deferSuccess) {
            logger.warn(`Masskick interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'masskick'
            });
            return;
        }

        const usersInput = interaction.options.getString("users");
        const reason = interaction.options.getString("reason") || "طرد جماعي - لم يتم تحديد سبب";

        try {
            const userIds = usersInput
                .replace(/<@!?(\d+)>/g, '$1')
                .split(/[\s,]+/)
                .filter(id => id && /^\d+$/.test(id))
                .slice(0, 20);

            if (userIds.length === 0) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: 'يرجى إدخال معرفات أعضاء أو منشنات صحيحة. الحد الأقصى هو 20 عضوًا في نفس الوقت.'
                });
            }

            if (userIds.includes(interaction.user.id)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'لا يمكنك إضافة نفسك إلى قائمة الطرد الجماعي.'
                });
            }

            if (userIds.includes(client.user.id)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'لا يمكنك إضافة البوت إلى قائمة الطرد الجماعي.'
                });
            }

            const results = {
                successful: [],
                failed: [],
                skipped: []
            };

            for (const userId of userIds) {
                try {
                    const member = await interaction.guild.members.fetch(userId).catch(() => null);

                    if (!member) {
                        results.failed.push({
                            userId,
                            reason: "العضو غير موجود في السيرفر"
                        });
                        continue;
                    }

                    const modCheck = ModerationService.validateHierarchy(
                        interaction.member,
                        member,
                        'kick'
                    );

                    if (!modCheck.valid) {
                        results.skipped.push({
                            user: member.user.tag,
                            userId,
                            reason: ModerationService.buildHierarchySkipReason(
                                interaction.member,
                                member,
                                'kick'
                            ),
                        });
                        continue;
                    }

                    const botCheck = ModerationService.validateBotHierarchy(
                        member,
                        'kick'
                    );

                    if (!botCheck.valid) {
                        results.skipped.push({
                            user: member.user.tag,
                            userId,
                            reason: ModerationService.buildHierarchySkipReason(
                                interaction.member,
                                member,
                                'kick',
                                'bot'
                            ),
                        });
                        continue;
                    }

                    if (!member.kickable) {
                        results.skipped.push({
                            user: member.user.tag,
                            userId,
                            reason: 'العضو لديه صلاحية Administrator أو رتبة مُدارة، أو أن البوت لا يملك صلاحية طرد الأعضاء'
                        });
                        continue;
                    }

                    await member.kick(reason);

                    results.successful.push({
                        user: member.user.tag,
                        userId
                    });

                    await logModerationAction({
                        client,
                        guild: interaction.guild,
                        event: {
                            action: "Member Kicked",
                            target: `${member.user.tag} (${member.user.id})`,
                            executor: `${interaction.user.tag} (${interaction.user.id})`,
                            reason: `${reason} (Mass Kick)`,
                            metadata: {
                                userId: member.user.id,
                                moderatorId: interaction.user.id,
                                massKick: true
                            }
                        }
                    });

                } catch (error) {
                    logger.error(`Failed to kick user ${userId}:`, error);

                    const reason = error instanceof TitanBotError
                        ? (error.userMessage || error.message)
                        : (error.message || "خطأ غير معروف");

                    results.failed.push({
                        userId,
                        reason,
                    });
                }
            }

            let description = `**نتائج الطرد الجماعي:**\n\n`;

            if (results.successful.length > 0) {
                description += `✅ **تم طردهم بنجاح (${results.successful.length}):**\n`;

                results.successful.forEach(result => {
                    description += `• ${result.user} (${result.userId})\n`;
                });

                description += '\n';
            }

            if (results.skipped.length > 0) {
                description += `⚠️ **تم تخطيهم (${results.skipped.length}):**\n`;

                results.skipped.forEach(result => {
                    description += `• ${result.user} - ${result.reason}\n`;
                });

                description += '\n';
            }

            if (results.failed.length > 0) {
                description += `❌ **فشل طردهم (${results.failed.length}):**\n`;

                results.failed.forEach(result => {
                    description += `• ${result.userId} - ${result.reason}\n`;
                });
            }

            const embed = results.successful.length > 0
                ? successEmbed
                : warningEmbed;

            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    embed(
                        `👢 اكتمل الطرد الجماعي`,
                        description
                    )
                ]
            });

        } catch (error) {
            logger.error("Error in masskick command:", error);

            return await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'حدث خطأ أثناء تنفيذ الطرد الجماعي. يرجى المحاولة مرة أخرى لاحقًا.'
            });
        }
    }
};
