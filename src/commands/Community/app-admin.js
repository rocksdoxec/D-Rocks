import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ComponentType, LabelBuilder, RoleSelectMenuBuilder } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { getColor, getApplicationStatusColor } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import { withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import ApplicationService from '../../services/applicationService.js';
import {
    getApplicationSettings,
    saveApplicationSettings,
    getApplication,
    getApplications,
    updateApplication,
    getApplicationRoles,
    saveApplicationRoles,
    getApplicationRoleSettings,
    saveApplicationRoleSettings,
    deleteApplication
} from '../../utils/database.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import appDashboard from './modules/app_dashboard.js';

function getApplicationStatusPresentation(statusValue) {
    const normalized = typeof statusValue === 'string' ? statusValue.trim().toLowerCase() : 'unknown';
    const statusLabel =
        normalized === 'pending' ? 'قيد المراجعة' :
        normalized === 'approved' ? 'مقبول' :
        normalized === 'denied' ? 'مرفوض' :
        'غير معروف';

    const statusEmoji =
        normalized === 'pending' ? '🟡' :
        normalized === 'approved' ? '🟢' :
        normalized === 'denied' ? '🔴' :
        '⚪';

    return { normalized, statusLabel, statusEmoji };
}

export default {
    data: new SlashCommandBuilder()
        .setName("app-admin")
        .setDescription("إدارة طلبات التقديم للرتب")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        .addSubcommand((subcommand) =>
            subcommand
                .setName("setup")
                .setDescription("إعداد طلب تقديم جديد")
        )

        .addSubcommand((subcommand) =>
            subcommand
                .setName("review")
                .setDescription("قبول أو رفض طلب تقديم")
                .addStringOption((option) =>
                    option
                        .setName("id")
                        .setDescription("معرّف الطلب")
                        .setRequired(true),
                )
        )

        .addSubcommand((subcommand) =>
            subcommand
                .setName("list")
                .setDescription("عرض جميع طلبات التقديم")
                .addStringOption((option) =>
                    option
                        .setName("status")
                        .setDescription("تصفية الطلبات حسب الحالة")
                        .addChoices(
                            { name: "قيد المراجعة", value: "pending" },
                            { name: "مقبول", value: "approved" },
                            { name: "مرفوض", value: "denied" },
                        ),
                )
                .addStringOption((option) =>
                    option
                        .setName("role")
                        .setDescription("تصفية الطلبات حسب معرّف الرتبة"),
                )
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("تصفية الطلبات حسب العضو"),
                )
                .addNumberOption((option) =>
                    option
                        .setName("limit")
                        .setDescription("الحد الأقصى لعدد الطلبات المعروضة (الافتراضي: 10)")
                        .setMinValue(1)
                        .setMaxValue(25),
                ),
        )

        .addSubcommand((subcommand) =>
            subcommand
                .setName("dashboard")
                .setDescription("فتح لوحة إعدادات طلبات التقديم")
                .addStringOption((option) =>
                    option
                        .setName("application")
                        .setDescription("اختر طلبًا لتعديله")
                        .setRequired(false)
                        .setAutocomplete(true),
                ),
        ),

    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'يمكن استخدام هذا الأمر داخل السيرفر فقط.'
            });
        }

        const { options, guild, member } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand !== 'dashboard' && subcommand !== 'setup') {
            await InteractionHelper.safeDefer(interaction, {
                flags: ['Ephemeral']
            });
        }

        logger.info(`App-admin command executed: ${subcommand}`, {
            userId: interaction.user.id,
            guildId: guild.id,
            subcommand
        });

        await ApplicationService.checkManagerPermission(
            interaction.client,
            guild.id,
            member
        );

        if (subcommand === "setup") {
            await handleSetup(interaction);
        } else if (subcommand === "review") {
            await handleReview(interaction);
        } else if (subcommand === "list") {
            await handleList(interaction);
        } else if (subcommand === "dashboard") {
            const selectedAppName = interaction.options.getString("application");
            await appDashboard.execute(
                interaction,
                null,
                interaction.client,
                selectedAppName
            );
        }
    }, {
        type: 'command',
        commandName: 'app-admin'
    })
};

async function handleSetup(interaction) {

    if (interaction.deferred || interaction.replied) {
        return await replyUserError(interaction, {
            type: ErrorTypes.UNKNOWN,
            message: 'تمت معالجة هذا التفاعل بالفعل. يرجى تجربة الأمر مرة أخرى.'
        });
    }

    const modal = new ModalBuilder()
        .setCustomId('app_setup_modal')
        .setTitle('إعداد طلب تقديم جديد');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('role_id')
        .setPlaceholder('اختر الرتبة التي يمكن للأعضاء التقديم عليها')
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('رتبة التقديم')
        .setDescription('الرتبة التي سيتقدم الأعضاء للحصول عليها')
        .setRoleSelectMenuComponent(roleSelect);

    const appNameInput = new TextInputBuilder()
        .setCustomId('app_name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('مثال: مشرف، مساعد، مطور')
        .setMaxLength(50)
        .setMinLength(1)
        .setRequired(true);

    const appNameLabel = new LabelBuilder()
        .setLabel('اسم الطلب')
        .setTextInputComponent(appNameInput);

    const q1Input = new TextInputBuilder()
        .setCustomId('app_question_1')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('لماذا تريد الحصول على هذه الرتبة؟')
        .setMaxLength(100)
        .setMinLength(1)
        .setRequired(true);

    const q1Label = new LabelBuilder()
        .setLabel('السؤال 1 (مطلوب)')
        .setTextInputComponent(q1Input);

    const q2Input = new TextInputBuilder()
        .setCustomId('app_question_2')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('ما الخبرة التي لديك؟')
        .setMaxLength(100)
        .setMinLength(1)
        .setRequired(false);

    const q2Label = new LabelBuilder()
        .setLabel('السؤال 2 (اختياري)')
        .setTextInputComponent(q2Input);

    const q3Input = new TextInputBuilder()
        .setCustomId('app_question_3')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(false);

    const q3Label = new LabelBuilder()
        .setLabel('السؤال 3 (اختياري)')
        .setTextInputComponent(q3Input);

    modal.addLabelComponents(
        roleLabel,
        appNameLabel,
        q1Label,
        q2Label,
        q3Label
    );

    await interaction.showModal(modal);

    const submitted = await interaction.awaitModalSubmit({
        time: 15 * 60 * 1000,
        filter: (i) =>
            i.customId === 'app_setup_modal' &&
            i.user.id === interaction.user.id,
    }).catch(() => null);

    if (!submitted) {
        logger.info('App setup modal dismissed or timed out', {
            guildId: interaction.guild.id,
            userId: interaction.user.id
        });
        return;
    }

    const appName = submitted.fields.getTextInputValue('app_name').trim();
    const selectedRoles = submitted.fields.getSelectedRoles('role_id');
    const roleId = selectedRoles.first()?.id;

    if (!roleId) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: 'يجب عليك اختيار رتبة لطلب التقديم.'
        });
        return;
    }

    const questions = [
        submitted.fields.getTextInputValue('app_question_1').trim(),
        submitted.fields.getTextInputValue('app_question_2').trim(),
        submitted.fields.getTextInputValue('app_question_3').trim(),
    ].filter(q => q.length > 0);

    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);

    if (!role) {
        await replyUserError(submitted, {
            type: ErrorTypes.VALIDATION,
            message: 'تعذر العثور على الرتبة المحددة.'
        });
        return;
    }

    const existingRoles = await getApplicationRoles(
        interaction.client,
        interaction.guild.id
    );

    if (existingRoles.some(r => r.roleId === roleId)) {
        await replyUserError(submitted, {
            type: ErrorTypes.CONFIGURATION,
            message: `الرتبة ${role} مضافة بالفعل كطلب تقديم.`
        });
        return;
    }

    existingRoles.push({
        roleId: roleId,
        name: appName,
        enabled: true,
    });

    await saveApplicationRoles(
        interaction.client,
        interaction.guild.id,
        existingRoles
    );

    const settings = await getApplicationSettings(
        interaction.client,
        interaction.guild.id
    );

    if (!settings.enabled) {
        await ApplicationService.updateSettings(
            interaction.client,
            interaction.guild.id,
            { enabled: true }
        );
    }

    await saveApplicationRoleSettings(
        interaction.client,
        interaction.guild.id,
        roleId,
        { questions }
    );

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ تم إنشاء طلب التقديم',
                `تم إنشاء طلب **${appName}** للرتبة ${role} بنجاح.\n\nيمكنك تعديل قناة السجلات، ورتب الإدارة، والأسئلة، ومدة الاحتفاظ من لوحة التحكم.`
            )
        ],
        flags: ['Ephemeral'],
    });

    setTimeout(() => {
        appDashboard.execute(
            submitted,
            null,
            interaction.client,
            appName
        );
    }, 500);
}

async function handleReview(interaction) {
    const appId = interaction.options.getString("id");

    const application = await getApplication(
        interaction.client,
        interaction.guild.id,
        appId,
    );

    if (!application) {
        return await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: 'لم يتم العثور على طلب التقديم.'
        });
    }

    if (application.status !== "pending") {
        return await replyUserError(interaction, {
            type: ErrorTypes.UNKNOWN,
            message: 'تمت معالجة طلب التقديم هذا بالفعل.'
        });
    }

    const appEmbed = createEmbed({
        title: `مراجعة طلب التقديم`,
        description:
            `**العضو:** <@${application.userId}>\n` +
            `**الطلب:** ${application.roleName}\n` +
            `**معرّف الطلب:** \`${appId}\``,
        color: 'info',
    });

    if (application.answers && application.answers.length > 0) {
        application.answers.forEach((item, index) => {
            appEmbed.addFields({
                name: `السؤال ${index + 1}: ${item.question}`,
                value: item.answer || '*لم يتم تقديم إجابة*',
                inline: false
            });
        });
    }

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_review_approve_${appId}`)
            .setLabel('قبول')
            .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
            .setCustomId(`app_review_deny_${appId}`)
            .setLabel('رفض')
            .setStyle(ButtonStyle.Danger),
    );

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [appEmbed],
        components: [buttonRow],
        flags: ["Ephemeral"],
    });

    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i =>
            i.user.id === interaction.user.id &&
            (
                i.customId.startsWith(`app_review_approve_${appId}`) ||
                i.customId.startsWith(`app_review_deny_${appId}`)
            ),
        time: 300_000,
        max: 1,
    });

    collector.on('collect', async buttonInteraction => {
        const isApprove = buttonInteraction.customId.includes('approve');

        const reasonModal = new ModalBuilder()
            .setCustomId(`app_review_reason_${appId}_${isApprove ? 'approve' : 'deny'}`)
            .setTitle(`${isApprove ? 'قبول' : 'رفض'} طلب التقديم - السبب`);

        reasonModal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('review_reason')
                    .setLabel('السبب (اختياري)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('اكتب سبب هذا القرار...')
                    .setMaxLength(500)
                    .setRequired(false),
            ),
        );

        await buttonInteraction.showModal(reasonModal);

        try {
            const reasonSubmit = await buttonInteraction.awaitModalSubmit({
                time: 5 * 60 * 1000,
                filter: i =>
                    i.customId === `app_review_reason_${appId}_${isApprove ? 'approve' : 'deny'}` &&
                    i.user.id === buttonInteraction.user.id,
            }).catch(() => null);

            if (!reasonSubmit) return;

            const reason =
                reasonSubmit.fields.getTextInputValue('review_reason').trim() ||
                "لم يتم تحديد سبب.";

            const action = isApprove ? 'approve' : 'deny';
            const status = isApprove ? 'approved' : 'denied';

            const updatedApplication = await ApplicationService.reviewApplication(
                reasonSubmit.client,
                interaction.guild.id,
                appId,
                {
                    action,
                    reason,
                    reviewerId: reasonSubmit.user.id
                }
            );

            try {
                const user = await reasonSubmit.client.users.fetch(application.userId);
                const statusColor = getApplicationStatusColor(status);
                const reviewStatus = getApplicationStatusPresentation(status);

                const dmEmbed = createEmbed({
                    title: `${reviewStatus.statusEmoji} طلب التقديم ${reviewStatus.statusLabel}`,
                    description:
                        `تم **${status === 'approved' ? 'قبول' : 'رفض'}** طلبك للحصول على **${application.roleName}**.\n` +
                        `**الملاحظة:** ${reason}\n\n` +
                        `استخدم \`/apply status id:${appId}\` لعرض التفاصيل.`
                }).setColor(statusColor);

                await user.send({
                    embeds: [dmEmbed]
                });

            } catch (error) {
                logger.warn('Failed to send DM to user for application review', {
                    error: error.message,
                    userId: application.userId,
                    applicationId: appId
                });
            }

            if (application.logMessageId && application.logChannelId) {
                try {
                    const statusColor = getApplicationStatusColor(status);

                    const logChannel = interaction.guild.channels.cache.get(
                        application.logChannelId,
                    );

                    if (logChannel) {
                        const logMessage = await logChannel.messages.fetch(
                            application.logMessageId,
                        );

                        if (logMessage) {
                            const embed = logMessage.embeds[0];

                            if (embed) {
                                const reviewStatus = getApplicationStatusPresentation(status);

                                const newEmbed = EmbedBuilder.from(embed)
                                    .setColor(statusColor)
                                    .spliceFields(0, 1, {
                                        name: "الحالة",
                                        value: `${reviewStatus.statusEmoji} ${reviewStatus.statusLabel}`,
                                    });

                                await logMessage.edit({
                                    embeds: [newEmbed],
                                    components: [],
                                });
                            }
                        }
                    }

                } catch (error) {
                    logger.warn('Failed to update log message for application', {
                        error: error.message,
                        applicationId: appId,
                        logMessageId: application.logMessageId
                    });
                }
            }

            if (isApprove) {
                try {
                    const member = await interaction.guild.members.fetch(
                        application.userId,
                    );

                    await member.roles.add(application.roleId);

                } catch (error) {
                    logger.error('Failed to assign role to approved applicant', {
                        error: error.message,
                        userId: application.userId,
                        roleId: application.roleId,
                        applicationId: appId
                    });
                }
            }

            await reasonSubmit.reply({
                embeds: [
                    successEmbed(
                        `تم ${isApprove ? 'قبول' : 'رفض'} طلب التقديم`,
                        `تم **${isApprove ? 'قبول' : 'رفض'} طلب التقديم بنجاح.**`,
                    ),
                ],
                flags: ["Ephemeral"],
            });

        } catch (error) {
            logger.error('Error reviewing application:', error);

            await replyUserError(buttonInteraction, {
                type: ErrorTypes.UNKNOWN,
                message: 'حدث خطأ أثناء مراجعة طلب التقديم.'
            });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            const timeoutEmbed = createEmbed({
                title: 'انتهى وقت المراجعة',
                description: 'انتهى وقت استخدام أزرار مراجعة الطلب.',
                color: 'warning',
            });

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [timeoutEmbed],
                components: [],
            }).catch(() => {});
        }
    });
}

async function handleList(interaction) {
    const status = interaction.options.getString("status");
    const user = interaction.options.getUser("user");
    const limit = interaction.options.getNumber("limit") || 10;

    const filters = {};

    if (status) {
        filters.status = status;
    } else {
        filters.status = 'pending';
    }

    let applications = await getApplications(
        interaction.client,
        interaction.guild.id,
        filters,
    );

    if (!user) {
        applications = await Promise.all(
            applications.map(async (app) => {
                try {
                    await interaction.guild.members.fetch(app.userId);
                    return app;
                } catch {
                    await deleteApplication(
                        interaction.client,
                        interaction.guild.id,
                        app.id,
                        app.userId
                    );
                    return null;
                }
            })
        ).then(results => results.filter(Boolean));
    }

    if (user) {
        applications = applications.filter(
            (app) => app.userId === user.id
        );
    }

    if (applications.length === 0) {
        const applicationRoles = await getApplicationRoles(
            interaction.client,
            interaction.guild.id
        );

        if (applicationRoles.length > 0) {
            const embed = createEmbed({
                title: "لم يتم العثور على طلبات",
                description:
                    "لم يتم العثور على طلبات تقديم مطابقة للمعايير المحددة.\n\n" +
                    "ومع ذلك، توجد رتب التقديم التالية مضافة:"
            });

            applicationRoles.forEach((appRole, index) => {
                const role = interaction.guild.roles.cache.get(appRole.roleId);

                embed.addFields({
                    name: `${index + 1}. ${appRole.name}`,
                    value:
                        `**الرتبة:** ${role ? `<@&${appRole.roleId}>` : 'لم يتم العثور على الرتبة'}\n` +
                        `**متاحة للتقديم:** نعم`,
                    inline: false
                });
            });

            embed.setFooter({
                text: "يمكن للأعضاء التقديم باستخدام /apply submit أو عرض الرتب المتاحة باستخدام /apply list"
            });

            return InteractionHelper.safeEditReply(
                interaction,
                {
                    embeds: [embed],
                    flags: ["Ephemeral"]
                }
            );

        } else {
            return await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message:
                    'لم يتم العثور على أي طلبات أو رتب تقديم مضافة.\n' +
                    'استخدم إعدادات طلبات التقديم لإضافة رتب التقديم أولًا.'
            });
        }
    }

    applications = applications
        .sort(
            (a, b) =>
                new Date(b.createdAt) - new Date(a.createdAt)
        )
        .slice(0, limit);

    const embed = createEmbed({
        title: "طلبات التقديم المرسلة",
        description: `عرض ${applications.length} من طلبات التقديم.`,
    });

    applications.forEach((app) => {
        const statusView = getApplicationStatusPresentation(app?.status);
        const roleName = app?.roleName || 'رتبة غير معروفة';
        const username = app?.username || 'عضو غير معروف';
        const createdAt = app?.createdAt
            ? new Date(app.createdAt)
            : null;

        const createdAtDisplay =
            createdAt && !Number.isNaN(createdAt.getTime())
                ? createdAt.toLocaleString()
                : 'تاريخ غير معروف';

        embed.addFields({
            name: `${statusView.statusEmoji} ${roleName} - ${username}`,
            value:
                `**المعرّف:** \`${app.id}\`\n` +
                `**الحالة:** ${statusView.statusEmoji} ${statusView.statusLabel}\n` +
                `**التاريخ:** ${createdAtDisplay}`,
            inline: true,
        });
    });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [embed],
        flags: ["Ephemeral"],
    });
}
