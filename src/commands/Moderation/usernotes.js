import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { getFromDb, setInDb, deleteFromDb, getUserNotesKey, getUserNotesListKey } from '../../utils/database.js';
import { sanitizeInput } from '../../utils/validation.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
    data: new SlashCommandBuilder()
        ..setName("usernotes_disabled")
        .setDescription("إدارة ملاحظات الأعضاء لأغراض الإشراف")
        .addSubcommand(subcommand =>
            subcommand
                .setName("add")
                .setDescription("إضافة ملاحظة إلى عضو")
                .addUserOption(option =>
                    option
                        .setName("target")
                        .setDescription("العضو الذي تريد إضافة ملاحظة له")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("note")
                        .setDescription("الملاحظة التي تريد إضافتها")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("type")
                        .setDescription("نوع الملاحظة")
                        .addChoices(
                            { name: "تحذير", value: "warning" },
                            { name: "إيجابية", value: "positive" },
                            { name: "محايدة", value: "neutral" },
                            { name: "تنبيه", value: "alert" }
                        )
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("view")
                .setDescription("عرض ملاحظات عضو")
                .addUserOption(option =>
                    option
                        .setName("target")
                        .setDescription("العضو الذي تريد عرض ملاحظاته")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("remove")
                .setDescription("حذف ملاحظة محددة من عضو")
                .addUserOption(option =>
                    option
                        .setName("target")
                        .setDescription("العضو الذي تريد حذف ملاحظة منه")
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option
                        .setName("index")
                        .setDescription("رقم الملاحظة التي تريد حذفها")
                        .setRequired(true)
                        .setMinValue(1)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("clear")
                .setDescription("حذف جميع ملاحظات عضو")
                .addUserOption(option =>
                    option
                        .setName("target")
                        .setDescription("العضو الذي تريد حذف جميع ملاحظاته")
                        .setRequired(true)
                )
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    category: "moderation",

    async execute(interaction, config, client) {
        const subcommand = interaction.options.getSubcommand();
        const targetUser = interaction.options.getUser("target");
        const guildId = interaction.guild.id;

        if (subcommand !== "view" && subcommand !== "remove" && subcommand !== "clear" && subcommand !== "add") {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'يرجى اختيار أمر فرعي صالح.'
            });
        }

        let notes = [];
        if (targetUser) {
            const notesKey = getUserNotesKey(guildId, targetUser.id);
            notes = await getFromDb(notesKey, []);
        }

        try {
            switch (subcommand) {
                case "add":
                    return await handleAddNote(interaction, targetUser, notes, guildId);
                case "view":
                    return await handleViewNotes(interaction, targetUser, notes);
                case "remove":
                    return await handleRemoveNote(interaction, targetUser, notes, guildId);
                case "clear":
                    return await handleClearNotes(interaction, targetUser, notes, guildId);
                default:
                    return await replyUserError(interaction, {
                        type: ErrorTypes.VALIDATION,
                        message: 'يرجى اختيار أمر فرعي صالح.'
                    });
            }
        } catch (error) {
            logger.error(`Error in usernotes command (${subcommand}):`, error);
            return await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'حدث خطأ أثناء تنفيذ طلبك. يرجى المحاولة مرة أخرى لاحقًا.'
            });
        }
    }
};

async function handleAddNote(interaction, targetUser, notes, guildId) {
    let note = interaction.options.getString("note").trim();
    const type = interaction.options.getString("type") || "neutral";

    if (note.length > 1000) {
        return await replyUserError(interaction, {
            type: ErrorTypes.UNKNOWN,
            message: 'يجب ألا تتجاوز الملاحظة 1000 حرف.'
        });
    }

    if (note.length === 0) {
        return await replyUserError(interaction, {
            type: ErrorTypes.UNKNOWN,
            message: 'لا يمكن أن تكون الملاحظة فارغة.'
        });
    }

    note = sanitizeInput(note);

    const noteData = {
        id: Date.now(),
        content: note,
        type: type,
        author: interaction.user.tag,
        authorId: interaction.user.id,
        timestamp: new Date().toISOString()
    };

    notes.push(noteData);

    const notesKey = getUserNotesKey(guildId, targetUser.id);
    await setInDb(notesKey, notes);

    const typeInfo = getNoteTypeInfo(type);

    const typeNames = {
        warning: "تحذير",
        positive: "إيجابية",
        neutral: "محايدة",
        alert: "تنبيه"
    };

    return InteractionHelper.safeReply(interaction, {
        embeds: [
            successEmbed(
                `${typeInfo.emoji} تمت إضافة الملاحظة`,
                `تمت إضافة ملاحظة **${typeNames[type] || "محايدة"}** إلى **${targetUser.tag}**:\n\n` +
                `> ${note}\n\n` +
                `**المشرف:** ${interaction.user.tag}\n` +
                `**إجمالي الملاحظات:** ${notes.length}`
            )
        ]
    });
}

async function handleViewNotes(interaction, targetUser, notes) {
    if (notes.length === 0) {
        return InteractionHelper.safeReply(interaction, {
            embeds: [
                infoEmbed(
                    "📝 لا توجد ملاحظات",
                    `لا توجد أي ملاحظات مسجلة لـ **${targetUser.tag}**.`
                ),
            ],
        });
    }

    const sortedNotes = [...notes].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const typeNames = {
        warning: "تحذير",
        positive: "إيجابية",
        neutral: "محايدة",
        alert: "تنبيه"
    };

    let description = `**ملاحظات ${targetUser.tag} (${targetUser.id}):**\n\n`;
    
    sortedNotes.forEach((note, index) => {
        const typeInfo = getNoteTypeInfo(note.type);
        const date = new Date(note.timestamp).toLocaleDateString();
        description += `${typeInfo.emoji} **الملاحظة #${index + 1}** (${typeNames[note.type] || "محايدة"}) - ${date}\n`;
        description += `> ${note.content}\n`;
        description += `*تمت الإضافة بواسطة ${note.author}*\n\n`;
    });

    if (description.length > 4000) {
        description = description.substring(0, 3900) + "\n... *(تم اختصار المحتوى)*";
    }

    return InteractionHelper.safeReply(interaction, {
        embeds: [
            infoEmbed(
                `📝 ملاحظات العضو (${notes.length})`,
                description
            )
        ]
    });
}

async function handleRemoveNote(interaction, targetUser, notes, guildId) {
    const index = interaction.options.getInteger("index") - 1;

    if (index < 0 || index >= notes.length) {
        return await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: `يرجى إدخال رقم ملاحظة صالح (1-${notes.length}).`
        });
    }

    // The view command displays notes sorted newest-first, so resolve the index
    // against the same ordering to delete the note the user actually sees.
    const sortedNotes = [...notes].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const removedNote = sortedNotes[index];
    const originalIndex = notes.indexOf(removedNote);
    notes.splice(originalIndex, 1);

    const notesKey = getUserNotesKey(guildId, targetUser.id);
    await setInDb(notesKey, notes);

    const typeInfo = getNoteTypeInfo(removedNote.type);

    return InteractionHelper.safeReply(interaction, {
        embeds: [
            successEmbed(
                `${typeInfo.emoji} تمت إزالة الملاحظة`,
                `تم حذف الملاحظة رقم **${index + 1}** من **${targetUser.tag}**:\n\n` +
                `> ${removedNote.content}\n\n` +
                `**الملاحظات المتبقية:** ${notes.length}`
            )
        ]
    });
}

async function handleClearNotes(interaction, targetUser, notes, guildId) {
    const noteCount = notes.length;
    
    if (noteCount === 0) {
        return InteractionHelper.safeReply(interaction, {
            embeds: [
                infoEmbed(
                    "لا توجد ملاحظات للحذف",
                    `لا توجد أي ملاحظات لـ **${targetUser.tag}** لحذفها.`
                ),
            ],
        });
    }

    notes.length = 0;

    const notesKey = getUserNotesKey(guildId, targetUser.id);
    await setInDb(notesKey, notes);

    return InteractionHelper.safeReply(interaction, {
        embeds: [
            successEmbed(
                "🗑️ تم حذف الملاحظات",
                `تم حذف **${noteCount}** ملاحظة من **${targetUser.tag}**.`
            )
        ]
    });
}

function getNoteTypeInfo(type) {
    const types = {
        warning: { emoji: "⚠️", color: "#FF6B6B" },
        positive: { emoji: "✅", color: "#51CF66" },
        neutral: { emoji: "📝", color: "#74C0FC" },
        alert: { emoji: "🚨", color: "#FFD43B" }
    };
    
    return types[type] || types.neutral;
}
