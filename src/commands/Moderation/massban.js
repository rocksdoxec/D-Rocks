import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logModerationAction } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { ModerationService } from '../../services/moderation/moderationService.js';
import { TitanBotError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName("massban")
        .setDescription("حظر عدة أعضاء من السيرفر في نفس الوقت")
        .addStringOption(option =>
            option
                .setName("users")
                .setDescription("معرفات المستخدمين أو المنشنات لحظرهم (افصل بينهم بمسافات أو فواصل)")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("reason")
                .setDescription("سبب الحظر الجماعي")
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option
                .setName("delete_days")
                .setDescription("عدد أيام الرسائل التي سيتم حذفها (0-7)")
                .setMinValue(0)
                .setMaxValue(7)
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    category: "moderation",
    abuseProtection: { maxAttempts: 3, windowMs: 60_000 },

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);

        if (!deferSuccess) {
            logger.warn(`Massban interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'massban'
            });
            return;
        }

        const usersInput = interaction.options.getString("users");
        const reason = interaction.options.getString("reason") || "حظر جماعي - لم يتم تحديد سبب";
        const deleteDays = interaction.options.getInteger("delete_days") || 0;

        try {
            const userIds = usersInput
                .replace(/<@!?(\d+)>/g, '$1')
                .split(/[\s,]+/)
                .filter(id => id && /^\d+$/.test(id))
                .slice(0, 20);

            if (userIds.length === 0) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: 'يرجى إدخال معرفات مستخدمين أو منشنات صحيحة. الحد الأقصى هو 20 مستخدمًا في نفس الوقت.'
                });
            }

            if (userIds.includes(interaction.user.id)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'لا يمكنك إضافة نفسك إلى الحظر الجماعي.'
                });
            }

            if (userIds.includes(client.user.id)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'لا يمكنك إضافة البوت إلى الحظر الجماعي.'
                });
            }

            const results = {
                successful: [],
                failed: [],
                skipped: []
            };

            for (const userId of userIds) {
                try {
                    const user = await client.users.fetch(userId).catch(() => null);

                    if (!user) {
                        results.failed.push({
                            userId,
                            reason: "المستخدم غير موجود"
                        });
                        continue;
                    }

                    const member = await interaction.guild.members.fetch(userId).catch(() => null);

                    if (member) {
                        const modCheck = ModerationService.validateHierarchy(
                            interaction.member,
                            member,
                            'ban'
                        );

                        if (!modCheck.valid) {
                            results.skipped.push({
                                user: user.tag,
                                userId,
                                reason: ModerationService.buildHierarchySkipReason(
                                    interaction.member,
                                    member,
                                    'ban'
                                ),
                            });
                            continue;
                        }

                        const botCheck = ModerationService.validateBotHierarchy(member, 'ban');

                        if (!botCheck.valid) {
                            results.skipped.push({
                                user: user.tag,
                                userId,
                                reason: ModerationService.buildHierarchySkipReason(
                                    interaction.member,
                                    member,
                                    'ban',
                                    'bot'
                                ),
                            });
                            continue;
                        }
                    }

                    await interaction.guild.members.ban(userId, {
                        reason: reason,
                        deleteMessageSeconds: deleteDays * 24 * 60 * 60
                    });

                    results.successful.push({
                        user: user.tag,
                        userId
                    });

                    await logModerationAction({
                        client,
                        guild: interaction.guild,
                        event: {
                            action: "Member Banned",
                            target: `${user.tag} (${user.id})`,
                            executor: `${interaction.user.tag} (${interaction.user.id})`,
                            reason: `${reason} (Mass Ban)`,
                            metadata: {
                                userId: user.id,
                                moderatorId: interaction.user.id,
                                massBan: true,
                                permanent: true
                            }
                        }
                    });

                } catch (error) {
                    logger.error(`Failed to ban user ${userId}:`, error);

                    const reason = error instanceof TitanBotError
                        ? (error.userMessage || error.message)
                        : (error.message || "خطأ غير معروف");

                    results.failed.push({
                        userId,
                        reason,
                    });
                }
            }

            let description = `**نتائج الحظر الجماعي:**\n\n`;

            if (results.successful.length > 0) {
                description += `✅ **تم حظرهم بنجاح (${results.successful.length}):**\n`;

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
                description += `❌ **فشل الحظر (${results.failed.length}):**\n`;

                results.failed.forEach(result => {
                    description += `• ${result.userId} - ${result.reason}\n`;
                });
            }

            const embed = results.successful.length > 0 ? successEmbed : warningEmbed;

            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    embed(
                        `🔨 **اكتمل الحظر الجماعي**`,
                        description
                    )
                ]
            });

        } catch (error) {
            logger.error("Error in massban command:", error);

            return await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'حدث خطأ أثناء تنفيذ الحظر الجماعي. يرجى المحاولة مرة أخرى لاحقًا.'
            });
        }
    }
};
