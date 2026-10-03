import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
} from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { sanitizeInput } from '../../utils/validation.js';

const TEXT_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
];

// ضع Discord User ID الخاص بك هنا
const OWNER_ID = '617895141490819082';

function resolveTargetChannel(interaction) {
    const selected = interaction.options.getChannel('channel');

    if (selected) {
        return selected;
    }

    if (!interaction.channel || !TEXT_CHANNEL_TYPES.includes(interaction.channel.type)) {
        return null;
    }

    return interaction.channel;
}

export default {
    data: new SlashCommandBuilder()
        .setName('say')
        .setDescription('إرسال رسالة نصية بواسطة البوت')
        .addStringOption((option) =>
            option
                .setName('message')
                .setDescription('الرسالة التي سيقوم البوت بإرسالها')
                .setRequired(true)
                .setMaxLength(2000),
        )
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('القناة التي سيتم إرسال الرسالة فيها، افتراضيًا القناة الحالية')
                .addChannelTypes(...TEXT_CHANNEL_TYPES)
                .setRequired(false),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .setDMPermission(false),

    category: 'moderation',
    abuseProtection: { maxAttempts: 8, windowMs: 60_000 },

    async execute(interaction, _config, client) {

        // السماح لك فقط باستخدام الأمر
if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({
        content: '❌ ليس لديك صلاحية استخدام هذا الأمر.',
        flags: MessageFlags.Ephemeral,
    });
}

        const deferSuccess = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });

        if (!deferSuccess) {
            logger.warn('Say interaction defer failed', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'say',
            });
            return;
        }

        const rawMessage = interaction.options.getString('message');
        const message = sanitizeInput(rawMessage, 2000);

        if (!message) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'لا يمكن أن تكون الرسالة فارغة.',
            });
        }

        const channel = resolveTargetChannel(interaction);

        if (!channel) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'اختر قناة نصية أو استخدم الأمر داخل قناة نصية.',
            });
        }

        const memberPermissions = channel.permissionsFor(interaction.member);
        const botPermissions = channel.permissionsFor(interaction.guild.members.me);

        if (!memberPermissions?.has(PermissionFlagsBits.SendMessages)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `ليس لديك صلاحية إرسال رسائل في ${channel}.`,
            });
        }

        if (!botPermissions?.has(PermissionFlagsBits.SendMessages)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: `ليس لدي صلاحية إرسال رسائل في ${channel}.`,
            });
        }

        const sentMessage = await channel.send({
            content: message,
        });

        await logEvent({
            client,
            guild: interaction.guild,
            event: {
                action: 'Bot Message Sent',
                target: `${channel} (${channel.id})`,
                executor: `${interaction.user.tag} (${interaction.user.id})`,
                reason: message.length > 200
                    ? `${message.slice(0, 197)}...`
                    : message,
                metadata: {
                    channelId: channel.id,
                    messageId: sentMessage.id,
                    moderatorId: interaction.user.id,
                    messageLength: message.length,
                },
            },
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    'تم إرسال الرسالة',
                    `تم إرسال الرسالة في ${channel}. [الانتقال إلى الرسالة](${sentMessage.url})`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};
