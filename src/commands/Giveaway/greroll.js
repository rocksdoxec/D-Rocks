import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildGiveaways, saveGiveaway } from '../../utils/giveaways.js';
import { 
    selectWinners,
    createGiveawayEmbed, 
    createGiveawayButtons 
} from '../../services/giveawayService.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName("greroll")
        .setDescription("إعادة اختيار الفائز أو الفائزين لسحب انتهى.")
        .addStringOption((option) =>
            option
                .setName("messageid")
                .setDescription("معرّف رسالة السحب الذي انتهى.")
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            throw new TitanBotError(
                'Giveaway command used outside guild',
                ErrorTypes.VALIDATION,
                'لا يمكن استخدام هذا الأمر إلا داخل السيرفر.',
                { userId: interaction.user.id }
            );
        }

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            throw new TitanBotError(
                'User lacks ManageGuild permission',
                ErrorTypes.PERMISSION,
                "تحتاج إلى صلاحية **إدارة السيرفر** لإعادة اختيار الفائزين.",
                { userId: interaction.user.id, guildId: interaction.guildId }
            );
        }

        logger.info(`Giveaway reroll initiated by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const messageId = interaction.options.getString("messageid");

        if (!messageId || !/^\d+$/.test(messageId)) {
            throw new TitanBotError(
                'Invalid message ID format',
                ErrorTypes.VALIDATION,
                'يرجى إدخال معرّف رسالة صالح.',
                { providedId: messageId }
            );
        }

        const giveaways = await getGuildGiveaways(
            interaction.client,
            interaction.guildId,
        );

        const giveaway = giveaways.find(g => g.messageId === messageId);

        if (!giveaway) {
            throw new TitanBotError(
                `Giveaway not found: ${messageId}`,
                ErrorTypes.VALIDATION,
                "لم يتم العثور على سحب باستخدام معرّف الرسالة هذا في قاعدة البيانات.",
                { messageId, guildId: interaction.guildId }
            );
        }

        if (!giveaway.isEnded && !giveaway.ended) {
            throw new TitanBotError(
                `Giveaway still active: ${messageId}`,
                ErrorTypes.VALIDATION,
                "هذا السحب لا يزال نشطًا. استخدم `/gend` لإنهائه أولًا.",
                { messageId, status: 'active' }
            );
        }

        const participants = giveaway.participants || [];

        if (participants.length < giveaway.winnerCount) {
            throw new TitanBotError(
                `Insufficient participants for reroll: ${participants.length} < ${giveaway.winnerCount}`,
                ErrorTypes.VALIDATION,
                "عدد المشاركات غير كافٍ لاختيار العدد المطلوب من الفائزين.",
                { participantsCount: participants.length, winnersNeeded: giveaway.winnerCount }
            );
        }

        const newWinners = selectWinners(
            participants,
            giveaway.winnerCount,
        );

        const updatedGiveaway = {
            ...giveaway,
            winnerIds: newWinners,
            rerolledAt: new Date().toISOString(),
            rerolledBy: interaction.user.id
        };

        const channel = await interaction.client.channels.fetch(
            giveaway.channelId,
        ).catch(err => {
            logger.warn(`Could not fetch channel ${giveaway.channelId}:`, err.message);
            return null;
        });

        if (!channel || !channel.isTextBased()) {

            await saveGiveaway(
                interaction.client,
                interaction.guildId,
                updatedGiveaway,
            );

            logger.warn(`Could not find channel for giveaway ${messageId}, but saved new winners to database`);

            return InteractionHelper.safeReply(interaction, {
                embeds: [
                    successEmbed(
                        "اكتملت إعادة القرعة",
                        "تم اختيار الفائزين الجدد وحفظهم في قاعدة البيانات، ولكن تعذر العثور على القناة للإعلان عنهم.",
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }

        const message = await channel.messages
            .fetch(messageId)
            .catch(err => {
                logger.warn(`Could not fetch message ${messageId}:`, err.message);
                return null;
            });

        if (!message) {

            await saveGiveaway(
                interaction.client,
                interaction.guildId,
                updatedGiveaway,
            );

            const winnerMentions = newWinners
                .map((id) => `<@${id}>`)
                .join(",");

            const existingPingMsg = giveaway.winnerPingMessageId
                ? await channel.messages.fetch(giveaway.winnerPingMessageId).catch(() => null)
                : null;
            if (existingPingMsg) {
                await existingPingMsg.edit({
                    content: `🔄 **إعادة اختيار الفائزين** 🔄 الفائزون الجدد في سحب **${giveaway.prize}**: ${winnerMentions}!`,
                });
            } else {
                const newPingMsg = await channel.send({
                    content: `🔄 **إعادة اختيار الفائزين** 🔄 الفائزون الجدد في سحب **${giveaway.prize}**: ${winnerMentions}!`,
                });
                updatedGiveaway.winnerPingMessageId = newPingMsg.id;
            }

            logger.info(`Giveaway rerolled (message not found, but announced): ${messageId}`);

            try {
                await logEvent({
                    client: interaction.client,
                    guildId: interaction.guildId,
                    eventType: EVENT_TYPES.GIVEAWAY_REROLL,
                    data: {
                        description: `Giveaway rerolled: ${giveaway.prize}`,
                        channelId: giveaway.channelId,
                        userId: interaction.user.id,
                        fields: [
                            {
                                name: 'Prize',
                                value: giveaway.prize || 'جائزة غامضة!',
                                inline: true
                            },
                            {
                                name: 'New Winners',
                                value: winnerMentions,
                                inline: false
                            },
                            {
                                name: 'Total Entries',
                                value: participants.length.toString(),
                                inline: true
                            }
                        ]
                    }
                });
            } catch (logError) {
                logger.debug('Error logging giveaway reroll:', logError);
            }

            return InteractionHelper.safeReply(interaction, {
                embeds: [
                    successEmbed(
                        "اكتملت إعادة القرعة",
                        `تم الإعلان عن الفائزين الجدد في ${channel}. (لم يتم العثور على الرسالة الأصلية).`,
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });
        }

        await saveGiveaway(
            interaction.client,
            interaction.guildId,
            updatedGiveaway,
        );

        const newEmbed = createGiveawayEmbed(updatedGiveaway, "reroll", newWinners);
        const newRow = createGiveawayButtons(true);

        await message.edit({
            content: "🔄 **تمت إعادة القرعة** 🔄",
            embeds: [newEmbed],
            components: [newRow],
        });

        const winnerMentions = newWinners
            .map((id) => `<@${id}>`)
            .join(",");

        const existingPingMsg = giveaway.winnerPingMessageId
            ? await channel.messages.fetch(giveaway.winnerPingMessageId).catch(() => null)
            : null;
        if (existingPingMsg) {
            await existingPingMsg.edit({
                content: `🔄 **الفائزون الجدد في إعادة القرعة** 🔄 تهانينا ${winnerMentions}! أنتم الفائزون الجدد بسحب **${giveaway.prize}**! يرجى التواصل مع صاحب السحب <@${giveaway.hostId}> لاستلام جائزتكم.`,
            });
        } else {
            const newPingMsg = await channel.send({
                content: `🔄 **الفائزون الجدد في إعادة القرعة** 🔄 تهانينا ${winnerMentions}! أنتم الفائزون الجدد بسحب **${giveaway.prize}**! يرجى التواصل مع صاحب السحب <@${giveaway.hostId}> لاستلام جائزتكم.`,
            });
            updatedGiveaway.winnerPingMessageId = newPingMsg.id;
        }

        logger.info(`Giveaway successfully rerolled: ${messageId} with ${newWinners.length} new winners`);

        try {
            await logEvent({
                client: interaction.client,
                guildId: interaction.guildId,
                eventType: EVENT_TYPES.GIVEAWAY_REROLL,
                data: {
                    description: `Giveaway rerolled: ${giveaway.prize}`,
                    channelId: giveaway.channelId,
                    userId: interaction.user.id,
                    fields: [
                        {
                            name: 'Prize',
                            value: giveaway.prize || 'جائزة غامضة!',
                            inline: true
                        },
                        {
                            name: 'New Winners',
                            value: winnerMentions,
                            inline: false
                        },
                        {
                            name: 'Total Entries',
                            value: participants.length.toString(),
                            inline: true
                        }
                    ]
                }
            });
        } catch (logError) {
            logger.debug('Error logging giveaway reroll event:', logError);
        }

        return InteractionHelper.safeReply(interaction, {
            embeds: [
                successEmbed(
                    "تمت إعادة القرعة بنجاح ✅",
                    `تمت إعادة اختيار الفائزين في سحب **${giveaway.prize}** في ${channel} بنجاح. تم اختيار ${newWinners.length} فائز(ين) جدد.`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
