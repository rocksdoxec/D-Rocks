import { addXp } from './xpSystem.js';
import { getLevelingConfig } from './leveling.js';
import { logger } from '../../utils/logger.js';

const VOICE_XP_PER_MINUTE = 5;
const VOICE_XP_INTERVAL = 60 * 1000;

const activeVoiceUsers = new Map();

function getSessionKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

export function startVoiceXpSystem(client) {
    if (client.__voiceXpInterval) {
        return;
    }

    client.__voiceXpInterval = setInterval(async () => {
        await processVoiceXp(client);
    }, VOICE_XP_INTERVAL);

    logger.info('🎙️ Voice XP system started.');
}

export function handleVoiceXpState(client, oldState, newState) {
    // لا تعطي البوتات XP
    if (newState.member?.user?.bot || oldState.member?.user?.bot) {
        return;
    }

    const guildId = newState.guild?.id || oldState.guild?.id;
    const userId = newState.member?.id || oldState.member?.id;

    if (!guildId || !userId) {
        return;
    }

    startVoiceXpSystem(client);

    const key = getSessionKey(guildId, userId);

    const oldChannelId = oldState.channel?.id || null;
    const newChannelId = newState.channel?.id || null;

    // خرج من الروم
    if (!newChannelId) {
        activeVoiceUsers.delete(key);
        return;
    }

    // دخل روم أو انتقل لروم آخر
    if (!oldChannelId || oldChannelId !== newChannelId) {
        if (!activeVoiceUsers.has(key)) {
            activeVoiceUsers.set(key, {
                guildId,
                userId,
                channelId: newChannelId,
                lastAwardAt: Date.now()
            });
        } else {
            activeVoiceUsers.get(key).channelId = newChannelId;
        }
    }
}

async function processVoiceXp(client) {
    const now = Date.now();

    for (const [key, session] of activeVoiceUsers) {
        try {
            const guild = client.guilds.cache.get(session.guildId);

            if (!guild) {
                activeVoiceUsers.delete(key);
                continue;
            }

            const member = await guild.members.fetch(session.userId).catch(() => null);

            if (!member || member.user.bot) {
                activeVoiceUsers.delete(key);
                continue;
            }

            // إذا خرج من الصوت
            if (!member.voice?.channel) {
                activeVoiceUsers.delete(key);
                continue;
            }

            // تحديث الروم الحالي
            session.channelId = member.voice.channel.id;

            const elapsed = now - session.lastAwardAt;

            const minutes = Math.floor(
                elapsed / VOICE_XP_INTERVAL
            );

            if (minutes <= 0) {
                continue;
            }

            const config = await getLevelingConfig(
                client,
                session.guildId
            );

            // إذا نظام اللفلات متوقف
            if (!config?.enabled) {
                session.lastAwardAt = now;
                continue;
            }

            // 5 XP لكل دقيقة
            const xpToAdd = minutes * VOICE_XP_PER_MINUTE;

            await addXp(
                client,
                guild,
                member,
                xpToAdd
            );

            session.lastAwardAt +=
                minutes * VOICE_XP_INTERVAL;

            logger.debug(
                `🎙️ Added ${xpToAdd} Voice XP to ${member.user.tag}`
            );

        } catch (error) {
            logger.error(
                `Voice XP error for ${session.userId}:`,
                error
            );
        }
    }
}
