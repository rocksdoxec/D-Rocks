import {
    ChannelType,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UserSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder
} from 'discord.js';

import {
    getJoinToCreateConfig,
    registerTemporaryChannel,
    unregisterTemporaryChannel,
    getTemporaryChannelInfo,
    formatChannelName
} from '../utils/database.js';

import { sanitizeInput } from '../utils/validation.js';
import { logger } from '../utils/logger.js';
import { handleMusicVoiceState } from '../services/music/musicVoiceState.js';

const channelCreationCooldown = new Map();

const VOICE_CREATE_COOLDOWN_MS = 2000;
const MAX_CHANNEL_NAME_LENGTH = 100;
const FALLBACK_CHANNEL_NAME = 'Voice Room';
const MAX_TRACKED_COOLDOWNS = 10000;

export default {
    name: 'voiceStateUpdate',

    async execute(oldState, newState, client) {
        if (newState.member?.user?.bot) return;

        const guildId = newState.guild.id;
        const userId = newState.member.id;
        const cooldownKey = `${guildId}-${userId}`;

        cleanupCooldownEntries();

        try {
            const config = await getJoinToCreateConfig(
                client,
                guildId
            );

            if (
                !config ||
                !config.enabled ||
                !Array.isArray(config.triggerChannels) ||
                config.triggerChannels.length === 0
            ) {
                return;
            }

            // دخول روم
            if (!oldState.channel && newState.channel) {
                await handleVoiceJoin(
                    client,
                    newState,
                    config,
                    cooldownKey
                );
            }

            // خروج من روم
            if (oldState.channel && !newState.channel) {
                await handleVoiceLeave(
                    client,
                    oldState,
                    config
                );
            }

            // الانتقال من روم إلى روم
            if (
                oldState.channel &&
                newState.channel &&
                oldState.channel.id !== newState.channel.id
            ) {
                await handleVoiceMove(
                    client,
                    oldState,
                    newState,
                    config,
                    cooldownKey
                );
            }
        } catch (error) {
            logger.error(
                `Error in voiceStateUpdate for guild ${guildId}:`,
                error
            );
        }

        /*
         * Music voice state handler
         * مهم: موجود هنا مرة واحدة فقط وداخل execute.
         */
        if (client.config?.features?.music) {
            handleMusicVoiceState(
                client,
                oldState,
                newState
            ).catch(error => {
                logger.error(
                    'Music voice state handler error:',
                    error
                );
            });
        }
    }
};

/* =========================================================
 * Voice Join
 * ========================================================= */

async function handleVoiceJoin(
    client,
    state,
    config,
    cooldownKey
) {
    const { channel, member } = state;

    if (!channel || !member) return;

    if (!config.triggerChannels.includes(channel.id)) {
        return;
    }

    const now = Date.now();

    if (channelCreationCooldown.has(cooldownKey)) {
        const lastCreation =
            channelCreationCooldown.get(cooldownKey);

        if (
            now - lastCreation <
            VOICE_CREATE_COOLDOWN_MS
        ) {
            logger.warn(
                `User ${member.id} is on cooldown for channel creation`
            );

            return;
        }
    }

    /*
     * إذا عنده روم مؤقت موجود بالفعل،
     * رجعه له بدل إنشاء روم جديد.
     */
    const temporaryChannels =
        config.temporaryChannels || {};

    const existingTempChannel =
        Object.keys(temporaryChannels).find(
            tempChannelId => {
                const tempInfo =
                    temporaryChannels[tempChannelId];

                return (
                    tempInfo &&
                    tempInfo.ownerId === member.id
                );
            }
        );

    if (existingTempChannel) {
        const tempChannel =
            state.guild.channels.cache.get(
                existingTempChannel
            );

        if (tempChannel) {
            try {
                await member.voice.setChannel(
                    tempChannel
                );

                return;
            } catch (error) {
                logger.warn(
                    `Failed to move user ${member.id} to existing channel ${existingTempChannel}:`,
                    error
                );
            }
        }
    }

    /*
     * نتأكد أن العضو ما زال داخل الـ trigger.
     */
    if (member.voice.channel?.id !== channel.id) {
        return;
    }

    channelCreationCooldown.set(
        cooldownKey,
        now
    );

    trimCooldownMapIfNeeded();

    await createTemporaryChannel(
        client,
        state,
        config,
        cooldownKey
    );
}

/* =========================================================
 * Voice Leave
 * ========================================================= */

async function handleVoiceLeave(
    client,
    state,
    config
) {
    const { channel } = state;

    if (!channel) return;

    const tempChannelInfo =
        await getTemporaryChannelInfo(
            client,
            state.guild.id,
            channel.id
        );

    if (!tempChannelInfo) {
        return;
    }

    /*
     * الملكية دائمة.
     * خروج المالك لا ينقل الملكية لشخص آخر.
     *
     * إذا أصبح الروم فارغًا يتم حذفه.
     */
    if (channel.members.size === 0) {
        await deleteTemporaryChannel(
            client,
            channel,
            state.guild.id
        );
    }
}

/* =========================================================
 * Voice Move
 * ========================================================= */

async function handleVoiceMove(
    client,
    oldState,
    newState,
    config,
    cooldownKey
) {
    /*
     * معالجة الروم القديم.
     */
    if (oldState.channel) {
        const tempChannelInfo =
            await getTemporaryChannelInfo(
                client,
                oldState.guild.id,
                oldState.channel.id
            );

        if (tempChannelInfo) {
            /*
             * لا ننقل الملكية.
             * إذا أصبح الروم فارغًا نحذفه.
             */
            if (
                oldState.channel.members.size === 0
            ) {
                await deleteTemporaryChannel(
                    client,
                    oldState.channel,
                    oldState.guild.id
                );
            }
        }
    }

    /*
     * إذا انتقل المستخدم إلى الـ trigger
     * من روم آخر، أنشئ له رومًا مؤقتًا.
     */
    if (
        newState.channel &&
        config.triggerChannels.includes(
            newState.channel.id
        ) &&
        !config.triggerChannels.includes(
            oldState.channel?.id
        )
    ) {
        await handleVoiceJoin(
            client,
            newState,
            config,
            cooldownKey
        );
    }
}

/* =========================================================
 * Create Temporary Channel
 * ========================================================= */

async function createTemporaryChannel(
    client,
    state,
    config,
    cooldownKey
) {
    const {
        channel: triggerChannel,
        member,
        guild
    } = state;

    try {
        const me = guild.members.me;

        if (!me) {
            logger.warn(
                `Bot member cache unavailable while creating temporary channel in guild ${guild.id}`
            );

            channelCreationCooldown.delete(
                cooldownKey
            );

            return;
        }

        const triggerPermissions =
            triggerChannel.permissionsFor(me);

        if (
            !triggerPermissions?.has(
                PermissionFlagsBits.ManageChannels
            ) ||
            !triggerPermissions?.has(
                PermissionFlagsBits.MoveMembers
            ) ||
            !triggerPermissions?.has(
                PermissionFlagsBits.Connect
            )
        ) {
            logger.warn(
                `Missing required permissions for temporary channel creation in guild ${guild.id}`
            );

            channelCreationCooldown.delete(
                cooldownKey
            );

            return;
        }

        /*
         * إعدادات المالك المحفوظة.
         */
        const ownerSettings =
            getOwnerRoomSettings(
                config,
                member.id
            );

        const channelOptions =
            config.channelOptions?.[
                triggerChannel.id
            ] || {};

        const nameTemplate =
            channelOptions.nameTemplate ||
            config.channelNameTemplate ||
            "{username}'s Room";

        let userLimit =
            channelOptions.userLimit ??
            config.userLimit ??
            0;

        userLimit = Math.max(
            0,
            Math.min(
                99,
                Number(userLimit) || 0
            )
        );

        const existingChannels =
            guild.channels.cache.filter(
                c =>
                    c.parentId ===
                        triggerChannel.parentId &&
                    c.name.startsWith(
                        triggerChannel.name
                    )
            ).size;

        let finalName;

        if (
            nameTemplate.includes('{username}') ||
            nameTemplate.includes('{displayName}')
        ) {
            finalName = formatChannelName(
                nameTemplate,
                {
                    username:
                        member.user.username,

                    userTag:
                        member.user.tag,

                    displayName:
                        member.displayName,

                    guildName:
                        guild.name,

                    channelName:
                        triggerChannel.name
                }
            );
        } else {
            finalName =
                `${triggerChannel.name} ${existingChannels + 1}`;
        }

        const channelName =
            sanitizeVoiceChannelName(
                finalName
            );

        /*
         * تأكد أن العضو ما زال داخل trigger.
         */
        if (
            !member.voice?.channel ||
            member.voice.channel.id !==
                triggerChannel.id
        ) {
            channelCreationCooldown.delete(
                cooldownKey
            );

            return;
        }

        const tempChannel =
            await guild.channels.create({
                name: channelName,

                type: ChannelType.GuildVoice,

                parent:
                    triggerChannel.parentId,

                ...(userLimit > 0
                    ? { userLimit }
                    : {}),

                permissionOverwrites: [
                    {
                        id: member.id,

                        allow: [
                            PermissionFlagsBits.Connect,
                            PermissionFlagsBits.Speak,
                            PermissionFlagsBits.PrioritySpeaker,
                            PermissionFlagsBits.MoveMembers
                        ]
                    },

                    {
                        id: guild.id,

                        allow: [
                            PermissionFlagsBits.Connect,
                            PermissionFlagsBits.Speak
                        ]
                    }
                ]
            });

        /*
         * تسجيل الروم المؤقت.
         */
        await registerTemporaryChannel(
            client,
            guild.id,
            tempChannel.id,
            member.id,
            triggerChannel.id
        );

        /*
         * تطبيق إعدادات المالك المحفوظة.
         */

        if (ownerSettings.locked) {
            await tempChannel.permissionOverwrites.edit(
                guild.id,
                {
                    Connect: false
                }
            );
        }

        for (
            const allowedUserId of
                ownerSettings.allowedUserIds
        ) {
            if (allowedUserId === member.id) {
                continue;
            }

            await tempChannel.permissionOverwrites.edit(
                allowedUserId,
                {
                    Connect: true,
                    Speak: true
                }
            );
        }

        for (
            const deniedUserId of
                ownerSettings.deniedUserIds
        ) {
            if (deniedUserId === member.id) {
                continue;
            }

            await tempChannel.permissionOverwrites.edit(
                deniedUserId,
                {
                    Connect: false
                }
            );
        }

        /*
         * إنشاء روم التحكم.
         */
        const controlChannel =
            await createControlChannel(
                guild,
                tempChannel,
                member
            );

        /*
         * حفظ controlChannelId.
         */
        const savedConfig =
            await getJoinToCreateConfig(
                client,
                guild.id
            );

        if (
            savedConfig?.temporaryChannels?.[
                tempChannel.id
            ]
        ) {
            savedConfig.temporaryChannels[
                tempChannel.id
            ].controlChannelId =
                controlChannel.id;

            await client.db.set(
                `guild:${guild.id}:jointocreate`,
                savedConfig
            );
        }

        /*
         * إرسال لوحة التحكم.
         */
        await sendControlPanel(
            controlChannel,
            tempChannel,
            member.id
        );

        /*
         * نقل المالك للروم الجديد.
         */
        if (
            member.voice?.channel?.id ===
            triggerChannel.id
        ) {
            await member.voice.setChannel(
                tempChannel
            );
        }

        logger.info(
            `Created temporary voice channel ${tempChannel.name} (${tempChannel.id}) and control channel ${controlChannel.id} for user ${member.user.tag}`
        );
    } catch (error) {
        logger.error(
            `Failed to create temporary channel for user ${member.user.tag}:`,
            error
        );

        channelCreationCooldown.delete(
            cooldownKey
        );

        try {
            await member.send({
                content:
                    '❌ تعذر إنشاء رومك الصوتية المؤقتة. يرجى التواصل مع أحد مسؤولي السيرفر.'
            });
        } catch (dmError) {
            logger.debug(
                `Unable to send temporary channel failure DM to user ${member.id}:`,
                dmError
            );
        }
    }
}

/* =========================================================
 * Delete Temporary Channel
 * ========================================================= */

async function deleteTemporaryChannel(
    client,
    channel,
    guildId
) {
    try {
        const config =
            await getJoinToCreateConfig(
                client,
                guildId
            );

        const tempInfo =
            config?.temporaryChannels?.[
                channel.id
            ];

        const controlChannelId =
            tempInfo?.controlChannelId;

        await unregisterTemporaryChannel(
            client,
            guildId,
            channel.id
        );

        if (controlChannelId) {
            const controlChannel =
                channel.guild.channels.cache.get(
                    controlChannelId
                );

            if (controlChannel) {
                await controlChannel.delete(
                    'Temporary voice channel deleted'
                );
            }
        }

        if (channel.deletable) {
            await channel.delete(
                'Temporary voice channel - empty'
            );
        }

        logger.info(
            `Deleted temporary voice channel ${channel.name} (${channel.id})`
        );
    } catch (error) {
        logger.error(
            `Failed to delete temporary channel ${channel.id}:`,
            error
        );
    }
}

/* =========================================================
 * Create Control Channel
 * ========================================================= */

async function createControlChannel(
    guild,
    voiceChannel,
    owner
) {
    const me = guild.members.me;

    return await guild.channels.create({
        name:
            `${voiceChannel.name}・control`.slice(
                0,
                100
            ),

        type: ChannelType.GuildText,

        parent:
            voiceChannel.parentId,

        permissionOverwrites: [
            {
                id: guild.id,

                deny: [
                    PermissionFlagsBits.ViewChannel
                ]
            },

            {
                id: owner.id,

                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory
                ]
            },

            ...(me
                ? [
                    {
                        id: me.id,

                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.ManageChannels
                        ]
                    }
                ]
                : [])
        ]
    });
}

/* =========================================================
 * Control Panel
 * ========================================================= */

async function sendControlPanel(
    controlChannel,
    voiceChannel,
    ownerId
) {
    const createPanelEmbed = () =>
        new EmbedBuilder()
            .setTitle(
                '🎛️ لوحة تحكم الروم'
            )
            .setDescription(
                `تحكم في **${voiceChannel.name}** من هنا.\n\n` +
                `🔒 **قفل الروم:** يمنع الأشخاص الجدد من الدخول.\n` +
                `🔓 **فتح الروم:** يسمح بالدخول للجميع مرة أخرى.\n` +
                `👤 **إضافة شخص:** يسمح لشخص محدد بالدخول حتى أثناء القفل.\n` +
                `👤 **إزالة شخص:** يمنع شخصًا محددًا من الدخول.\n` +
                `✏️ **تغيير الاسم:** تغيير اسم الروم الصوتية.`
            );

    const createButtons = () =>
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(
                    `jtc_lock_${voiceChannel.id}`
                )
                .setLabel('قفل الروم')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
                .setCustomId(
                    `jtc_unlock_${voiceChannel.id}`
                )
                .setLabel('فتح الروم')
                .setEmoji('🔓')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId(
                    `jtc_add_${voiceChannel.id}`
                )
                .setLabel('إضافة شخص')
                .setEmoji('👤')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId(
                    `jtc_remove_${voiceChannel.id}`
                )
                .setLabel('إزالة شخص')
                .setEmoji('👤')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId(
                    `jtc_rename_${voiceChannel.id}`
                )
                .setLabel('تغيير الاسم')
                .setEmoji('✏️')
                .setStyle(ButtonStyle.Secondary)
        );

    const message =
        await controlChannel.send({
            content:
                `👑 <@${ownerId}>`,

            embeds: [
                createPanelEmbed()
            ],

            components: [
                createButtons()
            ]
        });

    const collector =
        message.createMessageComponentCollector({
            time: 0
        });

    collector.on(
        'collect',
        async interaction => {
            try {
                const channelId =
                    voiceChannel.id;

                const config =
                    await getJoinToCreateConfig(
                        interaction.client,
                        interaction.guild.id
                    );

                const tempInfo =
                    config?.temporaryChannels?.[
                        channelId
                    ];

                if (!tempInfo) {
                    await interaction.reply({
                        content:
                            '❌ لم تعد هذه الروم الصوتية موجودة.',
                        ephemeral: true
                    }).catch(() => {});

                    collector.stop(
                        'channel_deleted'
                    );

                    return;
                }

                /*
                 * المالك فقط يستطيع استخدام اللوحة.
                 */
                if (
                    tempInfo.ownerId !==
                    interaction.user.id
                ) {
                    await interaction.reply({
                        content:
                            '❌ فقط مالك الروم يستطيع استخدام لوحة التحكم.',
                        ephemeral: true
                    }).catch(() => {});

                    return;
                }

                const currentChannel =
                    interaction.guild.channels.cache.get(
                        channelId
                    );

                if (!currentChannel) {
                    await interaction.reply({
                        content:
                            '❌ لم تعد هذه الروم الصوتية موجودة.',
                        ephemeral: true
                    }).catch(() => {});

                    collector.stop(
                        'channel_deleted'
                    );

                    return;
                }

                /* =================================================
                 * Buttons
                 * ================================================= */

                if (interaction.isButton()) {
                    /*
                     * قفل
                     */
                    if (
                        interaction.customId ===
                        `jtc_lock_${channelId}`
                    ) {
                        await currentChannel
                            .permissionOverwrites
                            .edit(
                                interaction.guild.id,
                                {
                                    Connect: false
                                }
                            );

                        const settings =
                            getOwnerRoomSettings(
                                config,
                                tempInfo.ownerId
                            );

                        settings.locked = true;

                        await saveOwnerRoomSettings(
                            interaction.client,
                            interaction.guild.id,
                            tempInfo.ownerId,
                            settings
                        );

                        await interaction.reply({
                            content:
                                '🔒 تم قفل الروم. الأشخاص الموجودون حاليًا سيبقون داخلها.',
                            ephemeral: true
                        });

                        return;
                    }

                    /*
                     * فتح
                     */
                    if (
                        interaction.customId ===
                        `jtc_unlock_${channelId}`
                    ) {
                        await currentChannel
                            .permissionOverwrites
                            .edit(
                                interaction.guild.id,
                                {
                                    Connect: true
                                }
                            );

                        const settings =
                            getOwnerRoomSettings(
                                config,
                                tempInfo.ownerId
                            );

                        settings.locked = false;

                        await saveOwnerRoomSettings(
                            interaction.client,
                            interaction.guild.id,
                            tempInfo.ownerId,
                            settings
                        );

                        await interaction.reply({
                            content:
                                '🔓 تم فتح الروم. أصبح بإمكان الأعضاء الدخول مرة أخرى.',
                            ephemeral: true
                        });

                        return;
                    }

                    /*
                     * إضافة شخص
                     */
                    if (
                        interaction.customId ===
                        `jtc_add_${channelId}`
                    ) {
                        const select =
                            new UserSelectMenuBuilder()
                                .setCustomId(
                                    `jtc_add_user_${channelId}`
                                )
                                .setPlaceholder(
                                    'اختر الشخص الذي تريد إضافته'
                                )
                                .setMinValues(1)
                                .setMaxValues(1);

                        await interaction.update({
                            content:
                                '👤 اختر الشخص الذي تريد السماح له بدخول الروم:',

                            embeds: [],

                            components: [
                                new ActionRowBuilder()
                                    .addComponents(
                                        select
                                    )
                            ]
                        });

                        return;
                    }

                    /*
                     * إزالة شخص
                     */
                    if (
                        interaction.customId ===
                        `jtc_remove_${channelId}`
                    ) {
                        const select =
                            new UserSelectMenuBuilder()
                                .setCustomId(
                                    `jtc_remove_user_${channelId}`
                                )
                                .setPlaceholder(
                                    'اختر الشخص الذي تريد منعه من دخول الروم'
                                )
                                .setMinValues(1)
                                .setMaxValues(1);

                        await interaction.update({
                            content:
                                '👤 اختر الشخص الذي تريد منعه من دخول الروم:',

                            embeds: [],

                            components: [
                                new ActionRowBuilder()
                                    .addComponents(
                                        select
                                    )
                            ]
                        });

                        return;
                    }

                    /*
                     * تغيير الاسم
                     */
                    if (
                        interaction.customId ===
                        `jtc_rename_${channelId}`
                    ) {
                        const modal =
                            new ModalBuilder()
                                .setCustomId(
                                    `jtc_rename_modal_${channelId}`
                                )
                                .setTitle(
                                    'تغيير اسم الروم'
                                );

                        const nameInput =
                            new TextInputBuilder()
                                .setCustomId(
                                    'room_name'
                                )
                                .setLabel(
                                    'اسم الروم الجديد'
                                )
                                .setPlaceholder(
                                    'اكتب اسم الروم الجديد'
                                )
                                .setStyle(
                                    TextInputStyle.Short
                                )
                                .setMinLength(1)
                                .setMaxLength(100)
                                .setRequired(true)
                                .setValue(
                                    currentChannel.name
                                );

                        modal.addComponents(
                            new ActionRowBuilder()
                                .addComponents(
                                    nameInput
                                )
                        );

                        await interaction.showModal(
                            modal
                        );

                        const submitted =
                            await interaction
                                .awaitModalSubmit({
                                    time: 120000,

                                    filter:
                                        modalInteraction =>
                                            modalInteraction.user.id ===
                                                interaction.user.id &&
                                            modalInteraction.customId ===
                                                `jtc_rename_modal_${channelId}`
                                })
                                .catch(
                                    () => null
                                );

                        if (!submitted) {
                            return;
                        }

                        const newName =
                            sanitizeVoiceChannelName(
                                submitted.fields.getTextInputValue(
                                    'room_name'
                                )
                            );

                        if (!newName) {
                            await submitted.reply({
                                content:
                                    '❌ اسم الروم غير صالح.',
                                ephemeral: true
                            });

                            return;
                        }

                        await currentChannel.setName(
                            newName
                        );

                        const controlName =
                            `${newName}・control`.slice(
                                0,
                                100
                            );

                        await interaction.channel
                            .setName(
                                controlName
                            )
                            .catch(() => {});

                        await submitted.reply({
                            content:
                                `✅ تم تغيير اسم الروم إلى **${newName}**.`,
                            ephemeral: true
                        });

                        return;
                    }
                }

                /* =================================================
                 * User Select Menu
                 * ================================================= */

                if (
                    interaction.isUserSelectMenu()
                ) {
                    const selectedUserId =
                        interaction.values[0];

                    const selectedMember =
                        await interaction.guild.members
                            .fetch(
                                selectedUserId
                            )
                            .catch(
                                () => null
                            );

                    if (!selectedMember) {
                        await interaction.update({
                            content:
                                '❌ لم أتمكن من العثور على هذا العضو.',

                            embeds: [
                                createPanelEmbed()
                            ],

                            components: [
                                createButtons()
                            ]
                        });

                        return;
                    }

                    /*
                     * إضافة شخص
                     */
                    if (
                        interaction.customId ===
                        `jtc_add_user_${channelId}`
                    ) {
                        /*
                         * لا نسمح بإضافة المالك لنفسه
                         * كإعداد إضافي.
                         */
                        if (
                            selectedUserId ===
                            tempInfo.ownerId
                        ) {
                            await interaction.update({
                                content:
                                    '❌ هذا الشخص هو مالك الروم بالفعل.',

                                embeds: [
                                    createPanelEmbed()
                                ],

                                components: [
                                    createButtons()
                                ]
                            });

                            return;
                        }

                        await currentChannel
                            .permissionOverwrites
                            .edit(
                                selectedUserId,
                                {
                                    Connect: true,
                                    Speak: true
                                }
                            );

                        const addSettings =
                            getOwnerRoomSettings(
                                config,
                                tempInfo.ownerId
                            );

                        addSettings.allowedUserIds =
                            addSettings.allowedUserIds.filter(
                                userId =>
                                    userId !==
                                    selectedUserId
                            );

                        addSettings.allowedUserIds.push(
                            selectedUserId
                        );

                        addSettings.deniedUserIds =
                            addSettings.deniedUserIds.filter(
                                userId =>
                                    userId !==
                                    selectedUserId
                            );

                        await saveOwnerRoomSettings(
                            interaction.client,
                            interaction.guild.id,
                            tempInfo.ownerId,
                            addSettings
                        );

                        await interaction.update({
                            content:
                                `👑 <@${tempInfo.ownerId}>`,

                            embeds: [
                                createPanelEmbed()
                            ],

                            components: [
                                createButtons()
                            ]
                        });

                        return;
                    }

                    /*
                     * إزالة شخص
                     */
                    if (
                        interaction.customId ===
                        `jtc_remove_user_${channelId}`
                    ) {
                        if (
                            selectedUserId ===
                            tempInfo.ownerId
                        ) {
                            await interaction.update({
                                content:
                                    '❌ لا يمكنك إزالة مالك الروم.',

                                embeds: [
                                    createPanelEmbed()
                                ],

                                components: [
                                    createButtons()
                                ]
                            });

                            return;
                        }

                        await currentChannel
                            .permissionOverwrites
                            .edit(
                                selectedUserId,
                                {
                                    Connect: false
                                }
                            );

                        const removeSettings =
                            getOwnerRoomSettings(
                                config,
                                tempInfo.ownerId
                            );

                        removeSettings.deniedUserIds =
                            removeSettings.deniedUserIds.filter(
                                userId =>
                                    userId !==
                                    selectedUserId
                            );

                        removeSettings.deniedUserIds.push(
                            selectedUserId
                        );

                        removeSettings.allowedUserIds =
                            removeSettings.allowedUserIds.filter(
                                userId =>
                                    userId !==
                                    selectedUserId
                            );

                        await saveOwnerRoomSettings(
                            interaction.client,
                            interaction.guild.id,
                            tempInfo.ownerId,
                            removeSettings
                        );

                        await interaction.update({
                            content:
                                `👑 <@${tempInfo.ownerId}>`,

                            embeds: [
                                createPanelEmbed()
                            ],

                            components: [
                                createButtons()
                            ]
                        });

                        return;
                    }
                }
            } catch (error) {
                logger.error(
                    `JoinToCreate control panel error for channel ${voiceChannel.id}:`,
                    error
                );

                if (
                    !interaction.replied &&
                    !interaction.deferred
                ) {
                    await interaction.reply({
                        content:
                            '❌ حدث خطأ أثناء تنفيذ العملية.',
                        ephemeral: true
                    }).catch(() => {});
                }
            }
        }
    );
}

/* =========================================================
 * Owner Room Settings
 * ========================================================= */

function getOwnerRoomSettings(
    config,
    ownerId
) {
    const saved =
        config?.ownerRoomSettings?.[ownerId] ||
        {};

    return {
        locked:
            Boolean(saved.locked),

        allowedUserIds:
            Array.isArray(
                saved.allowedUserIds
            )
                ? [
                    ...new Set(
                        saved.allowedUserIds
                    )
                ]
                : [],

        deniedUserIds:
            Array.isArray(
                saved.deniedUserIds
            )
                ? [
                    ...new Set(
                        saved.deniedUserIds
                    )
                ]
                : []
    };
}

async function saveOwnerRoomSettings(
    client,
    guildId,
    ownerId,
    settings
) {
    const config =
        await getJoinToCreateConfig(
            client,
            guildId
        );

    if (!config.ownerRoomSettings) {
        config.ownerRoomSettings = {};
    }

    config.ownerRoomSettings[ownerId] = {
        locked:
            Boolean(settings.locked),

        allowedUserIds: [
            ...new Set(
                settings.allowedUserIds || []
            )
        ],

        deniedUserIds: [
            ...new Set(
                settings.deniedUserIds || []
            )
        ]
    };

    await client.db.set(
        `guild:${guildId}:jointocreate`,
        config
    );

    return config.ownerRoomSettings[
        ownerId
    ];
}

/* =========================================================
 * Channel Name Sanitization
 * ========================================================= */

function sanitizeVoiceChannelName(
    inputName
) {
    const safeName =
        sanitizeInput(
            String(inputName || ''),
            MAX_CHANNEL_NAME_LENGTH
        )
            .replace(
                /[\r\n\t]/g,
                ' '
            )
            .replace(
                /\s+/g,
                ' '
            )
            .trim();

    return (
        safeName ||
        FALLBACK_CHANNEL_NAME
    );
}

/* =========================================================
 * Cooldown Cleanup
 * ========================================================= */

function cleanupCooldownEntries() {
    const now = Date.now();

    for (
        const [
            key,
            timestamp
        ] of channelCreationCooldown.entries()
    ) {
        if (
            now - timestamp >=
            VOICE_CREATE_COOLDOWN_MS
        ) {
            channelCreationCooldown.delete(
                key
            );
        }
    }
}

function trimCooldownMapIfNeeded() {
    if (
        channelCreationCooldown.size <=
        MAX_TRACKED_COOLDOWNS
    ) {
        return;
    }

    const entries = [
        ...channelCreationCooldown.entries()
    ].sort(
        (a, b) =>
            a[1] - b[1]
    );

    const removeCount =
        channelCreationCooldown.size -
        MAX_TRACKED_COOLDOWNS;

    for (
        let index = 0;
        index < removeCount;
        index += 1
    ) {
        channelCreationCooldown.delete(
            entries[index][0]
        );
    }
}
