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
        if (newState.member.user.bot) return;

        const guildId = newState.guild.id;
        const userId = newState.member.id;
        const cooldownKey = `${guildId}-${userId}`;

        cleanupCooldownEntries();

        try {
            const config = await getJoinToCreateConfig(client, guildId);

            if (!config.enabled || config.triggerChannels.length === 0) {
                return;
            }

            if (!oldState.channel && newState.channel) {
                await handleVoiceJoin(client, newState, config);
            }

            if (oldState.channel && !newState.channel) {
                await handleVoiceLeave(client, oldState, config);
            }

            if (
                oldState.channel &&
                newState.channel &&
                oldState.channel.id !== newState.channel.id
            ) {
                await handleVoiceMove(client, oldState, newState, config);
            }

        } catch (error) {
            logger.error(
                `Error in voiceStateUpdate for guild ${guildId}:`,
                error
            );
        }

        async function handleVoiceJoin(client, state, config) {
            const { channel, member } = state;

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

            const existingTempChannel = Object.keys(
                config.temporaryChannels || {}
            ).find(tempChannelId => {
                const tempInfo =
                    config.temporaryChannels[tempChannelId];

                return (
                    tempInfo &&
                    tempInfo.ownerId === member.id
                );
            });

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
                config
            );
        }

        async function handleVoiceLeave(
            client,
            state,
            config
        ) {
            const { channel, member } = state;

            const tempChannelInfo =
                await getTemporaryChannelInfo(
                    client,
                    state.guild.id,
                    channel.id
                );

            if (!tempChannelInfo) {
                return;
            }

            if (channel.members.size === 0) {
                await deleteTemporaryChannel(
                    client,
                    channel,
                    state.guild.id
                );
            } else if (
                tempChannelInfo.ownerId === member.id
            ) {
                const nextMember =
                    channel.members.first();

                if (nextMember) {
                    await transferChannelOwnership(
                        client,
                        channel,
                        state.guild.id,
                        nextMember.id
                    );
                }
            }
        }

        async function handleVoiceMove(
            client,
            oldState,
            newState,
            config
        ) {
            if (oldState.channel) {
                const tempChannelInfo =
                    await getTemporaryChannelInfo(
                        client,
                        oldState.guild.id,
                        oldState.channel.id
                    );

                if (tempChannelInfo) {
                    if (
                        oldState.channel.members.size === 0
                    ) {
                        await deleteTemporaryChannel(
                            client,
                            oldState.channel,
                            oldState.guild.id
                        );
                    } else if (
                        tempChannelInfo.ownerId ===
                        oldState.member.id
                    ) {
                        const nextMember =
                            oldState.channel.members.first();

                        if (nextMember) {
                            await transferChannelOwnership(
                                client,
                                oldState.channel,
                                oldState.guild.id,
                                nextMember.id
                            );
                        }
                    }
                }
            }

            if (
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
                    config
                );
            }
        }

        async function createTemporaryChannel(
            client,
            state,
            config
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
                    !triggerPermissions?.has([
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.MoveMembers,
                        PermissionFlagsBits.Connect
                    ])
                ) {
                    logger.warn(
                        `Missing required permissions for temporary channel creation in guild ${guild.id}`
                    );

                    channelCreationCooldown.delete(
                        cooldownKey
                    );

                    return;
                }

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
                    Math.min(99, userLimit || 0)
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
                    nameTemplate.includes(
                        '{username}'
                    ) ||
                    nameTemplate.includes(
                        '{displayName}'
                    )
                ) {
                    finalName =
                        formatChannelName(
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
                        userLimit:
                            userLimit === 0
                                ? undefined
                                : userLimit,

                        permissionOverwrites: [
                            {
                                id: member.id,
                                allow: [
                                    'Connect',
                                    'Speak',
                                    'PrioritySpeaker',
                                    'MoveMembers'
                                ]
                            },
                            {
                                id: guild.id,
                                allow: [
                                    'Connect',
                                    'Speak'
                                ]
                            }
                        ]
                    });

                await registerTemporaryChannel(
                    client,
                    guild.id,
                    tempChannel.id,
                    member.id,
                    triggerChannel.id
                );

                const controlChannel =
                    await createControlChannel(
                        guild,
                        tempChannel,
                        member
                    );

                const savedConfig =
                    await getJoinToCreateConfig(
                        client,
                        guild.id
                    );

                if (
                    savedConfig.temporaryChannels?.[
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

                await sendControlPanel(
                    controlChannel,
                    tempChannel,
                    member.id
                );

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
                    config.temporaryChannels?.[
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

                await channel.delete(
                    'Temporary voice channel - empty'
                );

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

        async function transferChannelOwnership(
            client,
            channel,
            guildId,
            newOwnerId
        ) {
            try {
                const config =
                    await getJoinToCreateConfig(
                        client,
                        guildId
                    );

                const tempChannelInfo =
                    config.temporaryChannels[
                        channel.id
                    ];

                if (!tempChannelInfo) return;

                const oldOwnerId =
                    tempChannelInfo.ownerId;

                tempChannelInfo.ownerId =
                    newOwnerId;

                await client.db.set(
                    `guild:${guildId}:jointocreate`,
                    config
                );

                const newOwner =
                    await channel.guild.members.fetch(
                        newOwnerId
                    );

                if (newOwner) {
                    const channelOptions =
                        config.channelOptions?.[
                            tempChannelInfo
                                .triggerChannelId
                        ] || {};

                    const nameTemplate =
                        channelOptions.nameTemplate ||
                        config.channelNameTemplate ||
                        "{username}'s Room";

                    const newChannelName =
                        sanitizeVoiceChannelName(
                            formatChannelName(
                                nameTemplate,
                                {
                                    username:
                                        newOwner.user.username,
                                    userTag:
                                        newOwner.user.tag,
                                    displayName:
                                        newOwner.displayName,
                                    guildName:
                                        channel.guild.name,
                                    channelName:
                                        channel.guild.channels.cache.get(
                                            tempChannelInfo.triggerChannelId
                                        )?.name ||
                                        'Voice Channel'
                                }
                            )
                        );

                    await channel.setName(
                        newChannelName
                    );

                    if (
                        tempChannelInfo.controlChannelId
                    ) {
                        const controlChannel =
                            channel.guild.channels.cache.get(
                                tempChannelInfo.controlChannelId
                            );

                        if (controlChannel) {
                            if (oldOwnerId) {
                                await controlChannel
                                    .permissionOverwrites
                                    .delete(
                                        oldOwnerId
                                    )
                                    .catch(() => {});
                            }

                            await controlChannel
                                .permissionOverwrites
                                .edit(
                                    newOwnerId,
                                    {
                                        ViewChannel:
                                            true,
                                        SendMessages:
                                            true,
                                        ReadMessageHistory:
                                            true
                                    }
                                )
                                .catch(() => {});

                            await controlChannel
                                .setName(
                                    `${newChannelName}・control`.slice(
                                        0,
                                        100
                                    )
                                )
                                .catch(() => {});
                        }
                    }
                }

                logger.info(
                    `Transferred ownership of temporary channel ${channel.id} to user ${newOwnerId}`
                );

            } catch (error) {
                logger.error(
                    `Failed to transfer ownership of channel ${channel.id}:`,
                    error
                );
            }
        }

        if (
            client.config?.features?.music
        ) {
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

        parent: voiceChannel.parentId,

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
                    config.temporaryChannels?.[
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

                /*
                 * الأزرار
                 */

                if (
                    interaction.isButton()
                ) {
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

                        await interaction.reply({
                            content:
                                '🔒 تم قفل الروم. الأشخاص الموجودون حاليًا سيبقون داخلها.',
                            ephemeral: true
                        });

                        return;
                    }

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
                                    'اختر الشخص الذي تريد إزالته'
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
                            .catch(
                                () => {}
                            );

                        await submitted.reply({
                            content:
                                `✅ تم تغيير اسم الروم إلى **${newName}**.`,
                            ephemeral: true
                        });

                        return;
                    }
                }

                /*
                 * اختيار شخص
                 */

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
                        await currentChannel
                            .permissionOverwrites
                            .edit(
                                selectedUserId,
                                {
                                    Connect: true,
                                    Speak: true
                                }
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
                        await currentChannel
                            .permissionOverwrites
                            .edit(
                                selectedUserId,
                                {
                                    Connect: false
                                }
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
                    }).catch(
                        () => {}
                    );
                }
            }
        }
    );
}

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
