import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    LabelBuilder,
    ChannelType,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed, buildUserErrorEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildConfig, setConfigValue } from '../../services/config/guildConfig.js';
import ConfigService from '../../services/config/configService.js';
import { logger } from '../../utils/logger.js';
import { botConfig, getCommandPrefix } from '../../config/bot.js';

const DASHBOARD_CUSTOM_ID = 'config_select';
const WIZARD_BUTTON_ID = 'config_wizard';
const activeWizardSessions = new Set();

const DM_DISABLED_HELP = [
    '1. اضغط بزر الفأرة الأيمن على اسم السيرفر (على الهاتف: اضغط على اسم السيرفر في الأعلى).',
    '2. افتح **إعدادات الخصوصية**.',
    '3. فعّل **السماح بالرسائل الخاصة من أعضاء السيرفر**.',
    '4. اضغط على **بدء معالج الإعداد** مرة أخرى.',
].join('\n');

async function notifyWizardStarted(buttonInteraction) {
    await buttonInteraction.followUp({
        embeds: [infoEmbed(
            'تم بدء معالج الإعداد',
            'تحقق من رسائلك الخاصة — أرسلت لك أول سؤال للإعداد هناك.\n\nأجب عن كل سؤال في الرسائل الخاصة. اكتب `skip` للاحتفاظ بالقيمة الحالية.',
        )],
        flags: MessageFlags.Ephemeral,
    }).catch(() => {});
}

async function notifyWizardDmBlocked(buttonInteraction) {
    await replyUserError(buttonInteraction, {
        type: ErrorTypes.USER_INPUT,
        message: `تعذر إرسال رسالة خاصة لك. فعّل الرسائل الخاصة من هذا السيرفر ثم حاول مرة أخرى.\n\n${DM_DISABLED_HELP}`,
    }).catch(() => {});
}

function formatChannelMention(guild, channelId) {
    if (!channelId) {
        return '`غير محدد`';
    }
    const channel = guild.channels.cache.get(channelId);
    return channel ? `<#${channelId}>` : `#${channelId}`;
}

function formatRoleMention(guild, roleId) {
    if (!roleId) {
        return '`غير محدد`';
    }
    const role = guild.roles.cache.get(roleId);
    return role ? `<@&${roleId}>` : `@${roleId}`;
}

function getBotPresenceText() {
    const activity = botConfig.presence?.activities?.[0];
    if (!activity?.name) {
        return '`غير مكوّن`';
    }

    const typeLabels = ['يلعب', 'يبث', 'يستمع إلى', 'يشاهد', '', 'يتنافس في'];
    const typeLabel = typeLabels[activity.type];
    if (!typeLabel) {
        return activity.name;
    }

    return `${typeLabel} **${activity.name}**`;
}

function getThemeColorLines() {
    const colors = botConfig.embeds.colors;
    return [
        `🎨 الأساسي \`${colors.primary}\` · النجاح \`${colors.success}\``,
        `⚠️ التحذير \`${colors.warning}\` · الخطأ \`${colors.error}\``,
    ].join('\n');
}

function buildDashboardEmbed(config, guild) {
    const setupDone = config.setupWizardCompleted;

    return createEmbed({
        title: '⚙️ إعدادات السيرفر',
        description: `الإعدادات الأساسية لـ **${guild.name}**. اختر أحد الخيارات بالأسفل أو شغّل معالج الإعداد.`,
        color: 'info',
        fields: [
            {
                name: '⌨️ بادئة السيرفر',
                value: `\`${config.prefix || getCommandPrefix()}\``,
                inline: true,
            },
            {
                name: '🛡️ رتبة المشرفين',
                value: formatRoleMention(guild, config.modRole),
                inline: true,
            },
            {
                name: '📋 قناة اللوقات',
                value: formatChannelMention(guild, config.logging?.channels?.audit),
                inline: true,
            },
            {
                name: '💚 حالة البوت',
                value: getBotPresenceText(),
                inline: false,
            },
            {
                name: '🎨 مظهر الـ Embed',
                value: `${getThemeColorLines()}\n-# يتم تحديد الألوان من إعدادات البوت وتُطبّق بشكل عام.`,
                inline: false,
            },
            {
                name: '⚡ صلاحيات الأوامر',
                value: 'استخدم `/commands dashboard` لتفعيل أو تعطيل الأوامر والأوامر الفرعية.',
                inline: false,
            },
            {
                name: `${setupDone ? '✅' : '📝'} الإعداد`,
                value: setupDone
                    ? 'تم إكمال معالج الإعداد — يمكنك تشغيله مرة أخرى في أي وقت لتحديث الإعدادات.'
                    : 'شغّل معالج الإعداد لتكوين السيرفر بسرعة.',
                inline: false,
            },
        ],
        footer: 'تُغلق لوحة التحكم بعد 10 دقائق من عدم النشاط',
    });
}

function buildSettingsSelect(guildId) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASHBOARD_CUSTOM_ID}:${guildId}`)
            .setPlaceholder('⚙️ اختر إعدادًا لتعديله...')
            .addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel('بادئة السيرفر')
                    .setDescription('تغيير بادئة أوامر النص')
                    .setValue('prefix')
                    .setEmoji('⌨️'),
                new StringSelectMenuOptionBuilder()
                    .setLabel('رتبة المشرفين')
                    .setDescription('الرتبة المستخدمة لأوامر الإشراف')
                    .setValue('modRole')
                    .setEmoji('🛡️'),
                new StringSelectMenuOptionBuilder()
                    .setLabel('قناة اللوقات')
                    .setDescription('القناة التي تستقبل رسائل لوقات النظام')
                    .setValue('logChannelId')
                    .setEmoji('📋'),
            ),
    );
}

function buildButtonRow(config, guildId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${WIZARD_BUTTON_ID}:${guildId}`)
            .setLabel(config.setupWizardCompleted ? 'إعادة تشغيل معالج الإعداد' : 'بدء معالج الإعداد')
            .setEmoji('📝')
            .setStyle(config.setupWizardCompleted ? ButtonStyle.Secondary : ButtonStyle.Success),
    );
}

function extractId(value) {
    if (!value || typeof value !== 'string') return null;

    const channelMention = value.match(/<#!?(\d{17,19})>/);
    if (channelMention) return channelMention[1];

    const roleMention = value.match(/<@&(\d{17,19})>/);
    if (roleMention) return roleMention[1];

    const digits = value.match(/^(\d{17,19})$/);
    if (digits) return digits[1];

    return null;
}

async function askQuestion(dmChannel, userId, prompt, stepNumber, totalSteps) {
    await dmChannel.send({
        embeds: [createEmbed({
            title: `سؤال الإعداد ${stepNumber}/${totalSteps}`,
            description: prompt,
            color: 'primary',
        })],
    });

    const collected = await dmChannel.awaitMessages({
        filter: (message) => message.author.id === userId && !message.author.bot,
        max: 1,
        time: 180_000,
    }).catch(() => null);

    if (!collected || !collected.size) {
        await dmChannel.send({
            embeds: [buildUserErrorEmbed(ErrorTypes.RATE_LIMIT, 'لم تجب في الوقت المحدد. شغّل معالج الإعداد مرة أخرى عندما تكون جاهزًا.')],
        });
        return null;
    }

    const answer = collected.first().content.trim();
    if (answer.toLowerCase() === 'cancel') {
        await dmChannel.send({
            embeds: [infoEmbed('تم إلغاء الإعداد', 'تم إيقاف معالج الإعداد. ستبقى إجاباتك المحفوظة مطبّقة.')],
        });
        return { cancelled: true };
    }

    return { answer };
}

function formatSavedAck(key, value, guild) {
    if (key === 'prefix') {
        return `تم حفظ بادئة السيرفر كـ \`${value}\`.`;
    }

    if (key === 'logChannelId') {
        if (value === null) {
            return 'تم حذف قناة اللوقات.';
        }
        const channel = guild.channels.cache.get(value);
        return `تم حفظ قناة اللوقات كـ ${channel ?? `<#${value}>`}.`;
    }

    if (key === 'modRole') {
        if (value === null) {
            return 'تم حذف رتبة المشرفين.';
        }
        const role = guild.roles.cache.get(value);
        return `تم حفظ رتبة المشرفين كـ ${role ?? `<@&${value}>`}.`;
    }

    return 'تم حفظ الإعداد.';
}

async function validateGuildChannelId(guild, channelId) {
    const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        throw new Error('لم يتم العثور على هذه القناة في السيرفر أو أنها ليست قناة نصية.');
    }
    return channel.id;
}

async function validateGuildRoleId(guild, roleId) {
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        throw new Error('لم يتم العثور على هذه الرتبة في السيرفر.');
    }
    return role.id;
}

async function refreshDashboard(rootInteraction, config, guild) {
    const embed = buildDashboardEmbed(config, guild);
    const components = [buildButtonRow(config, guild.id), buildSettingsSelect(guild.id)];
    await InteractionHelper.safeEditReply(rootInteraction, { embeds: [embed], components }).catch(() => {});
}

async function runSetupWizard(buttonInteraction, config, guild, client, rootInteraction) {
    const user = buttonInteraction.user;

    if (activeWizardSessions.has(user.id)) {
        await buttonInteraction.followUp({
            embeds: [warningEmbed('الإعداد قيد التشغيل بالفعل', 'لديك بالفعل معالج إعداد مفتوح في رسائلك الخاصة. أجب هناك للمتابعة، أو اكتب `cancel` لإيقافه.')],
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
    }

    activeWizardSessions.add(user.id);

    let dmChannel;

    try {
        dmChannel = await user.createDM();
    } catch (error) {
        logger.warn('Failed to create DM channel for setup wizard', { userId: user.id, error: error.message });
        await notifyWizardDmBlocked(buttonInteraction);
        return;
    } finally {
        if (!dmChannel) {
            activeWizardSessions.delete(user.id);
        }
    }

    const prompts = [
        {
            key: 'prefix',
            skipMessage: 'سيتم الاحتفاظ ببادئة السيرفر الحالية.',
            question: 'ما هي بادئة الأوامر التي تريد أن يستخدمها هذا السيرفر؟\nالحالية: `' + (config.prefix || getCommandPrefix()) + '`\nاكتب `skip` للاحتفاظ بها، أو `cancel` لإيقاف الإعداد.',
            parse: async (answer) => {
                const normalized = answer.trim();
                if (normalized.toLowerCase() === 'skip') return undefined;
                if (/\s/.test(normalized) || normalized.length < 1 || normalized.length > 10) {
                    throw new Error('يجب أن تكون البادئة من 1 إلى 10 أحرف وبدون مسافات.');
                }
                return normalized;
            },
        },
        {
            key: 'logChannelId',
            skipMessage: 'سيتم الاحتفاظ بقناة اللوقات الحالية.',
            question: 'ما هي القناة التي يجب أن تستقبل لوقات البوت؟\nأرسل منشن القناة، أو معرّف القناة، أو `none` للحذف، أو `skip` للاحتفاظ بالقيمة الحالية، أو `cancel` لإيقاف الإعداد.',
            parse: async (answer) => {
                const normalized = answer.trim();
                if (normalized.toLowerCase() === 'skip') return undefined;
                if (normalized.toLowerCase() === 'none') return null;
                const id = extractId(normalized);
                if (!id) throw new Error('أرسل منشن قناة صالحًا أو معرّف قناة من هذا السيرفر.');
                return validateGuildChannelId(guild, id);
            },
        },
        {
            key: 'modRole',
            skipMessage: 'سيتم الاحتفاظ برتبة المشرفين الحالية.',
            question: 'ما هي الرتبة التي يجب أن يمتلكها المشرفون؟\nأرسل منشن الرتبة، أو معرّف الرتبة، أو `none` للحذف، أو `skip` للاحتفاظ بالقيمة الحالية، أو `cancel` لإيقاف الإعداد.',
            parse: async (answer) => {
                const normalized = answer.trim();
                if (normalized.toLowerCase() === 'skip') return undefined;
                if (normalized.toLowerCase() === 'none') return null;
                const id = extractId(normalized);
                if (!id) throw new Error('أرسل منشن رتبة صالحًا أو معرّف رتبة من هذا السيرفر.');
                return validateGuildRoleId(guild, id);
            },
        },
    ];

    const changes = {};
    const errors = [];
    let wizardCancelled = false;

    try {
        try {
            await dmChannel.send({
                embeds: [createEmbed({
                    title: '📝 معالج الإعداد',
                    description: 'أجب عن كل سؤال في هذه الرسائل الخاصة.\n\n• اكتب `skip` للاحتفاظ بالقيمة الحالية\n• اكتب `cancel` لإيقاف المعالج',
                    color: 'info',
                })],
            });
        } catch (error) {
            logger.warn('Failed to send setup wizard DM', { userId: user.id, error: error.message });
            await notifyWizardDmBlocked(buttonInteraction);
            return;
        }

        await notifyWizardStarted(buttonInteraction);

        for (let index = 0; index < prompts.length; index++) {
            const prompt = prompts[index];
            let answered = false;

            while (!answered) {
                const result = await askQuestion(
                    dmChannel,
                    user.id,
                    prompt.question,
                    index + 1,
                    prompts.length,
                );

                if (result === null) {
                    wizardCancelled = true;
                    answered = true;
                    break;
                }

                if (result.cancelled) {
                    wizardCancelled = true;
                    answered = true;
                    break;
                }

                try {
                    const value = await prompt.parse(result.answer);

                    if (value === undefined) {
                        await dmChannel.send({
                            embeds: [infoEmbed('تم التخطي', prompt.skipMessage)],
                        });
                    } else {
                        await ConfigService.updateSetting(client, guild.id, prompt.key, value, user.id);
                        changes[prompt.key] = value;
                        await dmChannel.send({
                            embeds: [successEmbed('تم الحفظ', formatSavedAck(prompt.key, value, guild))],
                        });

                        try {
                            const updatedConfig = await getGuildConfig(client, guild.id);
                            await refreshDashboard(rootInteraction, updatedConfig, guild);
                        } catch (refreshError) {
                            logger.debug('Failed to refresh dashboard during setup wizard', { error: refreshError.message });
                        }
                    }

                    answered = true;
                } catch (error) {
                    errors.push(`• ${prompt.key}: ${error.message}`);
                    await dmChannel.send({
                        embeds: [buildUserErrorEmbed(ErrorTypes.VALIDATION, `${error.message}\n\nيرجى الرد مرة أخرى بإجابة صحيحة أو `skip` أو `cancel`.`)],
                    });
                }
            }

            if (wizardCancelled) {
                break;
            }
        }

        if (!wizardCancelled) {
            try {
                await setConfigValue(client, guild.id, 'setupWizardCompleted', true);
            } catch (error) {
                logger.warn('Failed to persist setupWizardCompleted flag', { guildId: guild.id, error: error.message });
            }
        }

        const summaryTitle = wizardCancelled
            ? (Object.keys(changes).length > 0 ? 'تم إيقاف الإعداد' : 'تم إلغاء الإعداد')
            : (errors.length > 0 ? 'اكتمل الإعداد' : 'اكتمل الإعداد');

        const summaryBody = wizardCancelled
            ? (Object.keys(changes).length > 0
                ? `تم إيقاف الإعداد مبكرًا. تم حفظ **${Object.keys(changes).length}** إعدادات قبل الإيقاف.`
                : 'تم إيقاف معالج الإعداد قبل حفظ أي تغييرات.')
            : (Object.keys(changes).length > 0
                ? `تم تحديث **${Object.keys(changes).length}** إعدادات.${errors.length > 0 ? ' بعض الإجابات احتاجت إلى إعادة المحاولة.' : ''}`
                : 'لم يتم تطبيق أي تغييرات.');

        const summaryEmbed = createEmbed({
            title: wizardCancelled ? `⚠️ ${summaryTitle}` : `✅ ${summaryTitle}`,
            description: summaryBody,
            color: wizardCancelled ? 'warning' : (errors.length > 0 ? 'warning' : 'success'),
        });

        if (errors.length > 0) {
            const uniqueErrors = [...new Set(errors)];
            summaryEmbed.addFields({ name: 'المشاكل', value: uniqueErrors.join('\n').slice(0, 1024) });
        }

        await dmChannel.send({ embeds: [summaryEmbed] });

        try {
            const updatedConfig = await getGuildConfig(client, guild.id);
            await refreshDashboard(rootInteraction, updatedConfig, guild);
        } catch (error) {
            logger.debug('Failed to refresh dashboard after wizard completion', { error: error.message });
        }
    } finally {
        activeWizardSessions.delete(user.id);
    }
}

async function showSettingModal(selectInteraction, guildId, setting) {
    const modalCustomId = `config_wizard_modal:${setting}:${guildId}`;

    if (setting === 'logChannelId') {
        const modal = new ModalBuilder()
            .setCustomId(modalCustomId)
            .setTitle('📋 تحديث قناة اللوقات');

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('log_channel')
            .setPlaceholder('اختر قناة نصية...')
            .setMinValues(1)
            .setMaxValues(1)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true);

        const channelLabel = new LabelBuilder()
            .setLabel('قناة اللوقات')
            .setDescription('القناة التي سيتم إرسال رسائل لوقات النظام إليها')
            .setChannelSelectMenuComponent(channelSelect);

        modal.addLabelComponents(channelLabel);
        await selectInteraction.showModal(modal);
        return;
    }

    if (setting === 'modRole') {
        const modal = new ModalBuilder()
            .setCustomId(modalCustomId)
            .setTitle('🛡️ تحديث رتبة المشرفين');

        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId('mod_role')
            .setPlaceholder('اختر رتبة المشرفين...')
            .setMinValues(1)
            .setMaxValues(1)
            .setRequired(true);

        const roleLabel = new LabelBuilder()
            .setLabel('رتبة المشرفين')
            .setDescription('الرتبة المستخدمة لأوامر الإشراف')
            .setRoleSelectMenuComponent(roleSelect);

        modal.addLabelComponents(roleLabel);
        await selectInteraction.showModal(modal);
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(modalCustomId)
        .setTitle('تحديث بادئة السيرفر');

    const textInput = new TextInputBuilder()
        .setCustomId('value')
        .setLabel('البادئة الجديدة (1-10 أحرف، بدون مسافات)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(10);

    modal.addComponents(new ActionRowBuilder().addComponents(textInput));
    await selectInteraction.showModal(modal);
}

function resolveSettingModalValue(setting, submitted) {
    if (setting === 'logChannelId') {
        const channelId = submitted.fields.getField('log_channel')?.values?.[0];
        if (!channelId) {
            throw new Error('يرجى اختيار قناة اللوقات.');
        }
        return channelId;
    }

    if (setting === 'modRole') {
        const roleId = submitted.fields.getField('mod_role')?.values?.[0];
        if (!roleId) {
            throw new Error('يرجى اختيار رتبة المشرفين.');
        }
        return roleId;
    }

    const prefix = submitted.fields.getTextInputValue('value')?.trim();
    if (!prefix || prefix.length < 1 || prefix.length > 10 || /\s/.test(prefix)) {
        throw new Error('يجب أن تكون البادئة من 1 إلى 10 أحرف وبدون مسافات.');
    }
    return prefix;
}

function buildSettingSuccessMessage(setting, value, guild) {
    if (setting === 'logChannelId') {
        const channel = guild.channels.cache.get(value);
        return `تم تعيين قناة اللوقات إلى ${channel ?? `<#${value}>`}.`;
    }

    if (setting === 'modRole') {
        const role = guild.roles.cache.get(value);
        return `تم تعيين رتبة المشرفين إلى ${role ?? `<@&${value}>`}.`;
    }

    return `تم تعيين بادئة السيرفر إلى \`${value}\`.`;
}

async function handleSettingModalSubmit(selectInteraction, rootInteraction, setting, guildId, client) {
    const modalCustomId = `config_wizard_modal:${setting}:${guildId}`;

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: (modalInteraction) =>
                modalInteraction.customId === modalCustomId &&
                modalInteraction.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) {
        return;
    }

    try {
        const value = resolveSettingModalValue(setting, submitted);
        await ConfigService.updateSetting(client, guildId, setting, value, submitted.user.id);

        await submitted.reply({
            embeds: [successEmbed('تم تحديث الإعدادات', buildSettingSuccessMessage(setting, value, submitted.guild))],
            flags: MessageFlags.Ephemeral,
        });

        const updatedConfig = await getGuildConfig(client, guildId);
        await refreshDashboard(rootInteraction, updatedConfig, submitted.guild);
    } catch (error) {
        logger.error('Config wizard modal submit error:', error);
        await replyUserError(submitted, {
            type: ErrorTypes.CONFIGURATION,
            message: error.message || 'يرجى المحاولة مرة أخرى.',
        }).catch(() => {});
    }
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('configwizard')
        .setDescription('فتح لوحة إعدادات السيرفر ومعالج الإعداد')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false),
    category: 'Core',

    async execute(interaction) {
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
            if (!deferSuccess) {
                return;
            }

            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                return replyUserError(interaction, {
                    type: ErrorTypes.PERMISSION,
                    message: 'تحتاج إلى صلاحية **إدارة السيرفر** لاستخدام هذا الأمر.',
                });
            }

            const guildConfig = await getGuildConfig(interaction.client, interaction.guildId);
            const embed = buildDashboardEmbed(guildConfig, interaction.guild);
            const components = [buildButtonRow(guildConfig, interaction.guildId), buildSettingsSelect(interaction.guildId)];

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components });

            const replyMessage = await interaction.fetchReply().catch(() => null);
            if (!replyMessage) {
                return;
            }

            const collectorFilter = (componentInteraction) =>
                componentInteraction.user.id === interaction.user.id &&
                componentInteraction.customId.includes(`:${interaction.guildId}`);

            const componentCollector = replyMessage.createMessageComponentCollector({
                filter: collectorFilter,
                time: 600_000,
            });

            componentCollector.on('collect', async (componentInteraction) => {
                try {
                    if (componentInteraction.isButton()) {
                        await componentInteraction.deferUpdate();

                        if (componentInteraction.customId.startsWith(`${WIZARD_BUTTON_ID}:`)) {
                            const latestConfig = await getGuildConfig(interaction.client, interaction.guildId);
                            await runSetupWizard(componentInteraction, latestConfig, interaction.guild, interaction.client, interaction);
                        }
                        return;
                    }

                    if (componentInteraction.isStringSelectMenu()) {
                        const selected = componentInteraction.values[0];
                        await showSettingModal(componentInteraction, interaction.guildId, selected);
                        await handleSettingModalSubmit(
                            componentInteraction,
                            interaction,
                            selected,
                            interaction.guildId,
                            interaction.client,
                        );
                    }
                } catch (error) {
                    logger.error('Config dashboard interaction error:', error);
                    await replyUserError(componentInteraction, {
                        type: ErrorTypes.UNKNOWN,
                        message: 'فشل تنفيذ اختيارك. يرجى المحاولة مرة أخرى.',
                    }).catch(() => {});
                }
            });
        } catch (error) {
            logger.error('Config command error:', error);
            await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: 'فشل فتح لوحة إعدادات السيرفر. يرجى المحاولة مرة أخرى.',
            });
        }
    },
};
