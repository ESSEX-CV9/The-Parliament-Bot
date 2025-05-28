// src/modules/contest/components/applicationModal.js
const { 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

function createContestApplicationModal() {
    const modal = new ModalBuilder()
        .setCustomId('contest_application')
        .setTitle('赛事申请表单');
    
    const titleInput = new TextInputBuilder()
        .setCustomId('contest_title')
        .setLabel('比赛标题')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50)
        .setPlaceholder('请输入简洁明了的比赛标题（最多50字符）');
        
    const themeInput = new TextInputBuilder()
        .setCustomId('contest_theme')
        .setLabel('主题和参赛要求')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500)
        .setPlaceholder('详细描述比赛主题、参赛要求、作品格式等...');
        
    const durationInput = new TextInputBuilder()
        .setCustomId('contest_duration')
        .setLabel('比赛持续时间')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(20)
        .setPlaceholder('例如：30天、2周、1个月等');
        
    const awardsInput = new TextInputBuilder()
        .setCustomId('contest_awards')
        .setLabel('奖项设置和评价标准')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500)
        .setPlaceholder('描述奖项设置、评价标准、评选方式等...');
        
    const notesInput = new TextInputBuilder()
        .setCustomId('contest_notes')
        .setLabel('注意事项和其他补充')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000)
        .setPlaceholder('其他需要说明的事项（可选）');
    
    // 构建表单行
    const row1 = new ActionRowBuilder().addComponents(titleInput);
    const row2 = new ActionRowBuilder().addComponents(themeInput);
    const row3 = new ActionRowBuilder().addComponents(durationInput);
    const row4 = new ActionRowBuilder().addComponents(awardsInput);
    const row5 = new ActionRowBuilder().addComponents(notesInput);
    
    modal.addComponents(row1, row2, row3, row4, row5);
    
    return modal;
}

function createEditApplicationModal(existingData) {
    const modal = new ModalBuilder()
        .setCustomId('contest_edit_application')
        .setTitle('编辑赛事申请');
    
    const titleInput = new TextInputBuilder()
        .setCustomId('contest_title')
        .setLabel('比赛标题')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50)
        .setValue(existingData.title || '')
        .setPlaceholder('请输入简洁明了的比赛标题（最多50字符）');
        
    const themeInput = new TextInputBuilder()
        .setCustomId('contest_theme')
        .setLabel('主题和参赛要求')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500)
        .setValue(existingData.theme || '')
        .setPlaceholder('详细描述比赛主题、参赛要求、作品格式等...');
        
    const durationInput = new TextInputBuilder()
        .setCustomId('contest_duration')
        .setLabel('比赛持续时间')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(20)
        .setValue(existingData.duration || '')
        .setPlaceholder('例如：30天、2周、1个月等');
        
    const awardsInput = new TextInputBuilder()
        .setCustomId('contest_awards')
        .setLabel('奖项设置和评价标准')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500)
        .setValue(existingData.awards || '')
        .setPlaceholder('描述奖项设置、评价标准、评选方式等...');
        
    const notesInput = new TextInputBuilder()
        .setCustomId('contest_notes')
        .setLabel('注意事项和其他补充')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000)
        .setValue(existingData.notes || '')
        .setPlaceholder('其他需要说明的事项（可选）');
    
    // 构建表单行
    const row1 = new ActionRowBuilder().addComponents(titleInput);
    const row2 = new ActionRowBuilder().addComponents(themeInput);
    const row3 = new ActionRowBuilder().addComponents(durationInput);
    const row4 = new ActionRowBuilder().addComponents(awardsInput);
    const row5 = new ActionRowBuilder().addComponents(notesInput);
    
    modal.addComponents(row1, row2, row3, row4, row5);
    
    return modal;
}

module.exports = { 
    createContestApplicationModal,
    createEditApplicationModal
};