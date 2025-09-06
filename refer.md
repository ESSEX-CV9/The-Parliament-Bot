

一、模块位置与主文件
- 指令入口: [src/modules/selfModeration/commands/muteShitUser.js](src/modules/selfModeration/commands/muteShitUser.js)
- 通用处理服务: [src/modules/selfModeration/services/moderationService.js](src/modules/selfModeration/services/moderationService.js)
- 投票存取/合并: [src/modules/selfModeration/services/votingManager.js](src/modules/selfModeration/services/votingManager.js)
- 反应计数与阈值: [src/modules/selfModeration/services/reactionTracker.js](src/modules/selfModeration/services/reactionTracker.js)
- 定时检查与执行: [src/modules/selfModeration/services/moderationChecker.js](src/modules/selfModeration/services/moderationChecker.js)
- 惩罚执行（禁言/删除/归档）: [src/modules/selfModeration/services/punishmentExecutor.js](src/modules/selfModeration/services/punishmentExecutor.js)
- 频道校验/权限检查: [src/modules/selfModeration/utils/channelValidator.js](src/modules/selfModeration/utils/channelValidator.js)
- 链接解析: [src/modules/selfModeration/utils/messageParser.js](src/modules/selfModeration/utils/messageParser.js)
- 时间阈值/昼夜模式: [src/core/config/timeconfig.js](src/core/config/timeconfig.js)

二、Slash 指令工作流（/禁言搬屎用户）
- 指令定义与执行:
  - [javascript.data()](src/modules/selfModeration/commands/muteShitUser.js:8) 定义 /禁言搬屎用户 并接收“消息链接”
  - [javascript.execute()](src/modules/selfModeration/commands/muteShitUser.js:16) 具体流程:
    1) 仅限服务器环境使用
    2) deferReply(ephemeral)
    3) 读配置 [javascript.getSelfModerationSettings()](src/modules/selfModeration/commands/muteShitUser.js:30)
    4) 权限校验 [javascript.checkSelfModerationPermission()](src/modules/selfModeration/commands/muteShitUser.js:38)
    5) 冷却检查 [javascript.checkUserGlobalCooldown()](src/modules/selfModeration/commands/muteShitUser.js:46)
    6) 频道校验（当前使用指令的频道）[javascript.validateChannel()](src/modules/selfModeration/commands/muteShitUser.js:60)
    7) 调用通用流程 [javascript.processMessageUrlSubmission()](src/modules/selfModeration/commands/muteShitUser.js:72) 以 type='mute'
    8) 成功后更新最后使用时间 [javascript.updateUserLastUsage()](src/modules/selfModeration/commands/muteShitUser.js:76)

三、消息链接处理与投票创建
- 入口（通用）: [javascript.processMessageUrlSubmission()](src/modules/selfModeration/services/moderationService.js:100)
  - 读取配置与权限校验 [javascript.checkSelfModerationPermission()](src/modules/selfModeration/services/moderationService.js:111)
  - 校验“当前频道”允许使用 [javascript.validateChannel()](src/modules/selfModeration/services/moderationService.js:119)
  - 解析并验证链接（仅限本服务器）[javascript.parseMessageUrl()](src/modules/selfModeration/utils/messageParser.js:8) + 同服校验 [javascript.isMessageFromSameGuild()](src/modules/selfModeration/utils/messageParser.js:44)
  - 拉取目标消息并校验时间窗 [javascript.validateTargetMessage()](src/modules/selfModeration/services/moderationService.js:223)
  - 校验“目标消息所在频道”也在允许列表 [javascript.validateChannel()](src/modules/selfModeration/services/moderationService.js:150)
  - 校验机器人权限（按操作类型）[javascript.checkBotPermissions()](src/modules/selfModeration/utils/channelValidator.js:168)
  - 创建或合并投票 [javascript.createOrMergeVote()](src/modules/selfModeration/services/votingManager.js:10)
  - 发送投票公告 [javascript.sendVoteStartNotification()](src/modules/selfModeration/services/moderationService.js:277)

- 投票创建/合并:
  - 已存在同类型投票则合并发起者 [javascript.createOrMergeVote()](src/modules/selfModeration/services/votingManager.js:10)
  - 新投票 endTime 使用 [javascript.getSelfModerationVoteEndTime()](src/core/config/timeconfig.js:214)

- 投票公告内容:
  - 根据类型选择反应表情: mute=🚫 / delete=⚠️
  - 执行条件文本展示使用动态阈值: delete 用 [javascript.DELETE_THRESHOLD](src/core/config/timeconfig.js:133); mute 用 [javascript.MUTE_DURATIONS.LEVEL_1.threshold](src/core/config/timeconfig.js:111)
  - 显示当前时段模式（白天/夜晚）[javascript.getCurrentTimeMode()](src/core/config/timeconfig.js:79)

四、反应统计与阈值判定
- 反应表情映射:
  - [javascript.getVoteEmojis()](src/modules/selfModeration/services/reactionTracker.js:35) mute: ['🚫','🚯','no_entry_sign',':no_entry_sign:'] / delete: ['⚠️','⚠','warning',':warning:']

- 去重计数（目标消息 + 公告）:
  - [javascript.getDeduplicatedReactionCount()](src/modules/selfModeration/services/reactionTracker.js:115) 汇总两处相同表情的“去重用户数”

- 批量更新投票计数（定时器使用）:
  - [javascript.batchCheckReactions()](src/modules/selfModeration/services/reactionTracker.js:224) -> [javascript.updateVoteReactionCountWithDeduplication()](src/modules/selfModeration/services/reactionTracker.js:191)

- 阈值判定:
  - [javascript.checkReactionThreshold()](src/modules/selfModeration/services/reactionTracker.js:262)
    - delete: [javascript.DELETE_THRESHOLD](src/core/config/timeconfig.js:133)
    - mute: [javascript.MUTE_DURATIONS.LEVEL_1.threshold](src/core/config/timeconfig.js:111)

五、定时检查器与投票生命周期
- 启动与循环: [javascript.startSelfModerationChecker()](src/modules/selfModeration/services/moderationChecker.js:432) 使用 [javascript.getCheckIntervals()](src/core/config/timeconfig.js:224)
- 核心循环:
  - 拉取活跃投票 -> 批量刷新计数 [javascript.checkActiveModerationVotes()](src/modules/selfModeration/services/moderationChecker.js:14)
  - 单个投票处理 [javascript.processIndividualVote()](src/modules/selfModeration/services/moderationChecker.js:50)
    - 达阈值且未执行 -> 立即执行 [javascript.executePunishment()](src/modules/selfModeration/services/moderationChecker.js:166)
    - 超时 -> [javascript.handleExpiredVote()](src/modules/selfModeration/services/moderationChecker.js:192)

- 到期行为区分:
  - delete 投票: 结束即总结
  - mute 投票: 若到期时已达阈值，会在到期后删除目标消息 [javascript.deleteMessageAfterVoteEnd()](src/modules/selfModeration/services/punishmentExecutor.js:395) 并更新公告 [javascript.editVoteAnnouncementToExpired()](src/modules/selfModeration/services/moderationChecker.js:233)

六、禁言执行实现（按频道覆盖）
- 执行函数: [javascript.executeMuteUser()](src/modules/selfModeration/services/punishmentExecutor.js:211)
  - 依据当前已执行禁言累计，计算附加禁言时长与级别（依赖时间工具）[javascript.calculateAdditionalMuteDuration()](src/modules/selfModeration/services/punishmentExecutor.js:219)
  - 寻找可进行权限覆盖的频道（原频道或父频道）[javascript.getPermissionChannel()](src/modules/selfModeration/services/punishmentExecutor.js:183)
  - 设置权限覆盖（关闭发言/加反应/发帖等）[javascript.executeMuteUser()](src/modules/selfModeration/services/punishmentExecutor.js:263)
  - 记录执行动作到投票数据 executedActions（不立即标记投票完成）
  - 通过 setTimeout 在本进程内定时解除权限覆盖 [javascript.executeMuteUser()](src/modules/selfModeration/services/punishmentExecutor.js:299)

- 注意: 这是“频道级禁言（权限覆盖）”，非 Discord 超时（Timeout/Moderation）全局禁言

七、权限与频道校验
- 频道授权（当前频道 + 目标消息所在频道均需允许）:
  - [javascript.validateChannel()](src/modules/selfModeration/utils/channelValidator.js:10) 支持线程→父频道授权穿透
- 机器人权限检查:
  - 函数重复定义（见 97-141 与 168-212，属于重复实现）[src/modules/selfModeration/utils/channelValidator.js](src/modules/selfModeration/utils/channelValidator.js)
  - ‘mute’ 当前检查的是 ModerateMembers（管理成员）[javascript.checkBotPermissions()](src/modules/selfModeration/utils/channelValidator.js:195)，但实际“权限覆盖”需要 ManageChannels 才能修改频道覆盖；存在不匹配问题（详见问题1）

八、时间与阈值配置（含昼夜模式）
- 配置入口: [src/core/config/timeconfig.js](src/core/config/timeconfig.js)
- 自助管理投票时长: [javascript.getSelfModerationVoteEndTime()](src/core/config/timeconfig.js:214)
- 检查间隔: [javascript.getCheckIntervals()](src/core/config/timeconfig.js:224)
- 昼夜模式:
  - 删除阈值 DELETE_THRESHOLD 动态（夜晚按比例降低）[javascript.DELETE_THRESHOLD](src/core/config/timeconfig.js:133)
  - 禁言阈值 MUTE_DURATIONS.LEVEL_x.threshold 动态（夜晚按比例降低）[javascript.MUTE_DURATIONS](src/core/config/timeconfig.js:111)
  - 当前模式标识 [javascript.getCurrentTimeMode()](src/core/config/timeconfig.js:79)


整体流程小结
- 用户触发 /禁言搬屎用户 -> 校验权限/冷却/频道 -> 解析消息链接并验证 -> 为目标消息创建/合并“禁言投票” -> 发公告（🚫）提示并收集反应 -> 定时器汇总“目标消息+公告”的去重反应用户数 -> 达到阈值（昼夜动态）立即执行频道级禁言（权限覆盖）并记录 -> 投票截止后总结；若禁言投票达阈值，到期后删除原消息并可归档。


一、用户视角：/禁言搬屎用户 的完整流程
1) 发起指令
- 用户在服务器某允许频道里执行 /禁言搬屎用户 并粘贴目标消息链接。
- Slash 定义与入口: [javascript.data()](src/modules/selfModeration/commands/muteShitUser.js:8) 与 [javascript.execute()](src/modules/selfModeration/commands/muteShitUser.js:16)

2) 即时校验与反馈（私密提示）
- 仅限服务器使用、deferReply(ephemeral)。
- 读取自助管理设置、权限校验、个人全局冷却校验、当前频道是否允许。
- 若不通过，会在你的界面显示对应拒绝信息（私密）。
- 关键点: 
  - 服务器设置读取 [javascript.getSelfModerationSettings()](src/modules/selfModeration/commands/muteShitUser.js:30)
  - 权限检查 [javascript.checkSelfModerationPermission()](src/modules/selfModeration/commands/muteShitUser.js:38)
  - 冷却检查 [javascript.checkUserGlobalCooldown()](src/modules/selfModeration/commands/muteShitUser.js:46)
  - 当前频道允许 [javascript.validateChannel()](src/modules/selfModeration/commands/muteShitUser.js:60)

3) 校验目标消息与目标频道
- 解析链接、保证同服。
- 拉取目标消息、检查时间窗口（过久的消息不可发起投票）。
- 校验“目标消息所在频道”也必须被列入允许列表（线程会穿透到父频道）。
- 关键点:
  - 解析/同服校验 [javascript.parseMessageUrl()](src/modules/selfModeration/utils/messageParser.js:8)
  - 目标消息验证（含时间限制）[javascript.validateTargetMessage()](src/modules/selfModeration/services/moderationService.js:223)
  - 目标频道允许 [javascript.validateChannel()](src/modules/selfModeration/services/moderationService.js:150)

4) 创建或合并投票
- 如该消息已有同类型(mute)投票：合并发起人；否则创建新投票，设置开始/结束时间。
- 关键点: [javascript.createOrMergeVote()](src/modules/selfModeration/services/votingManager.js:10)

5) 公告消息与投票方式
- 机器人在你当前频道发送“投票公告”Embed，提示去目标消息或公告消息本身添加“🚫”来支持禁言。
- 同一用户无论在哪条消息添加，都只算一次（跨两处去重）。
- 公告示例逻辑: [javascript.sendVoteStartNotification()](src/modules/selfModeration/services/moderationService.js:277)
- 注意：初始“当前数量”展示存在一个显示偏差，详见后文“注意与已知差异-1”。

6) 统计进行中（用户通常看不到过程日志）
- 系统后台定时轮询，统计“🚫”的去重用户数（目标消息 + 公告），动态更新投票记录。
- 定时器启动与轮询: [javascript.startSelfModerationChecker()](src/modules/selfModeration/services/moderationChecker.js:432) → [javascript.checkActiveModerationVotes()](src/modules/selfModeration/services/moderationChecker.js:14)

7) 达成阈值 → 立即执行禁言
- 一旦去重后的“🚫”数量首次达到基础禁言阈值，系统立刻对目标用户执行“频道级禁言”（修改该频道或其父频道的权限覆盖），并在频道内发送“禁言成功”Embed（公开）。
- 执行逻辑与通知:
  - 判定与触发 [javascript.processIndividualVote()](src/modules/selfModeration/services/moderationChecker.js:50)
  - 具体禁言 [javascript.executeMuteUser()](src/modules/selfModeration/services/punishmentExecutor.js:211)
  - 结果通知 [javascript.sendPunishmentNotification()](src/modules/selfModeration/services/moderationChecker.js:309)

8) 投票截止 → 公告编辑为“已结束”
- 到达投票截止时间后，系统编辑原公告为“投票结束”状态。
- 对“禁言投票”，若结束时仍达到阈值，将“在投票结束后删除该目标消息”（并尝试归档），并在公告中写明结果。
- 截止处理与编辑公告: [javascript.handleExpiredVote()](src/modules/selfModeration/services/moderationChecker.js:192) → [javascript.editVoteAnnouncementToExpired()](src/modules/selfModeration/services/moderationChecker.js:233)
- 截止后删除消息（仅针对 mute 投票）: [javascript.deleteMessageAfterVoteEnd()](src/modules/selfModeration/services/punishmentExecutor.js:395)

9) 解除禁言（到期自动解除）
- 禁言到期后（本进程存的计时器），机器人自动恢复该用户在该频道的权限覆盖。
- 定时解除: [javascript.executeMuteUser()](src/modules/selfModeration/services/punishmentExecutor.js:299)

二、后台机制详解（数量统计、去重、阈值、时长“累加”）
1) 统计什么表情、统计在哪儿、如何去重
- 表情映射
  - 对“禁言投票”只统计 🚫（兼容别名/变体）: [javascript.getVoteEmojis()](src/modules/selfModeration/services/reactionTracker.js:35)
- 统计范围
  - 目标消息 与 投票公告 两处的 🚫 反应，合并去重。
- 去重规则
  - 以“用户ID集合”为准，排除机器人账号；同一用户在两处或多次添加，计为1。
- 关键实现
  - 单条消息反应用户集 [javascript.getVoteReactionUsers()](src/modules/selfModeration/services/reactionTracker.js:56)
  - 去重合并（目标消息 + 公告）[javascript.getDeduplicatedReactionCount()](src/modules/selfModeration/services/reactionTracker.js:115)
  - 批量刷新到 DB [javascript.batchCheckReactions()](src/modules/selfModeration/services/reactionTracker.js:224) → [javascript.updateVoteReactionCountWithDeduplication()](src/modules/selfModeration/services/reactionTracker.js:191)

2) 何时触发禁言：阈值判定
- 判定函数: [javascript.checkReactionThreshold()](src/modules/selfModeration/services/reactionTracker.js:262)
- 对“禁言投票”，仅用“基础禁言阈值”判定是否达到执行条件（默认 LEVEL_1 的 threshold）
  - 间隔轮询中，当首次达到基础阈值且该投票尚未执行过（executed=false），立即执行禁言一次。
  - 后续即便数量继续增加，也不会再次执行（详见“时长累加”）。

3) 白天/夜晚动态阈值
- 所有阈值（删除/禁言）会根据北京时间段自动调整（夜晚阈值更低）。
- 获取当前模式与阈值:
  - 昼夜模式 [javascript.getCurrentTimeMode()](src/core/config/timeconfig.js:79)
  - 删除阈值 [javascript.DELETE_THRESHOLD](src/core/config/timeconfig.js:133)
  - 禁言阈值/时长映射（MUTE_DURATIONS 代理返回“动态阈值 + 固定时长”）[javascript.MUTE_DURATIONS](src/core/config/timeconfig.js:111)

4) 禁言“时长累加”的真实行为
- 时长映射（按去重数量选高等级时长）
  - 计算当前应达到的禁言级别与“总时长” [javascript.calculateMuteDuration()](src/modules/selfModeration/utils/timeCalculator.js:9)
- “累加”的含义（代码层面的实现方式）
  - 计算“需要追加的分钟数 = 目标总时长 - 已执行累计时长” [javascript.calculateAdditionalMuteDuration()](src/modules/selfModeration/utils/timeCalculator.js:38)
  - 已执行累计时长来源于投票记录里的 executedActions 求和 [javascript.getCurrentMuteDuration()](src/modules/selfModeration/services/punishmentExecutor.js:348)
- 这套“累加”机制在本实现中的生效时机
  - 该投票在一次投票周期内“只会执行禁言一次”（因为 [javascript.processIndividualVote()](src/modules/selfModeration/services/moderationChecker.js:84) 要求 !executed 才会再次执行，而 [javascript.executeMuteUser()](src/modules/selfModeration/services/punishmentExecutor.js:289) 会把 executed 设为 true）。因此：
    - 当首次达阈值被执行时，会直接按“当时的去重数量”选定一个等级，并把“本次应该达到的总时长 - 之前累计时长”作为追加分钟一次性下发。
    - 在本次投票后续计数再上涨，不会触发二次“追加禁言”。“累加”更多是为理论上的“多次执行”或故障恢复准备的，但在当前流程下并不会在同一次投票里多次叠加。
- 用户体感
  - 也就是说：禁言时长取决于“首次达阈值那一刻的去重数量等级”。之后再涨，不会延长本轮投票的禁言时长。

5) 到期删除与终态汇报
- 仅针对“禁言投票”：到期若仍达基础阈值，会删除目标消息（并尽力归档）。
- 截止时重新计算基于“当前最终数量”的达成情况，因此可能出现：
  - 中途曾执行过禁言，但到期前被人撤反应导致“未达阈值”，最终公告显示“未达到执行条件，不删除消息”。

6) 权限模型（与用户体验直接相关）
- 前置条件
  - “当前指令频道”与“目标消息频道”都必须被管理员列为允许频道，否则直接拒绝。
  - 机器人必须具备相应权限。当前实现里“禁言”是“频道权限覆盖”的方式，而“机器人权限检查”写的是“ModerateMembers”（更像全局超时权限），与实际操作“需要 ManageChannels 修改权限覆盖”不完全一致。
- 用户可能看到的失败提示
  - “频道不允许使用”与“机器人权限不足”等私密错误信息会直接发在你的指令回执里。

三、用一张流程图快速总览（用户视角主干）
mermaid
flowchart TD
  A[/用户执行 /禁言搬屎用户 + 消息链接/] --> B[私密校验: 设置/权限/冷却/频道]
  B -->|通过| C[解析并验证目标消息+频道]
  B -->|不通过| X[私密错误提示(拒绝)]
  C --> D[创建/合并投票]
  D --> E[发送投票公告(提示添加🚫)]
  E --> F[后台周期统计: 去重(目标+公告), 只算人类]
  F -->|首次达到基础阈值| G[立即执行频道权限禁言]
  G --> H[频道内发送“禁言成功”公开通知]
  F -->|到期| I{到期时是否达阈值?}
  I -->|是| J[删除目标消息(尝试归档)]
  I -->|否| K[不删除]
  J --> L[编辑公告为“投票结束+结果”]
  K --> L[编辑公告为“投票结束+结果”]
（检索时可点开定位）
- 指令定义与执行: [javascript.data()](src/modules/selfModeration/commands/muteShitUser.js:8), [javascript.execute()](src/modules/selfModeration/commands/muteShitUser.js:16)
- 通用处理: [javascript.processMessageUrlSubmission()](src/modules/selfModeration/services/moderationService.js:100)
- 反应统计/去重/阈值: 
  - [javascript.getVoteReactionUsers()](src/modules/selfModeration/services/reactionTracker.js:56)
  - [javascript.getDeduplicatedReactionCount()](src/modules/selfModeration/services/reactionTracker.js:115)
  - [javascript.checkReactionThreshold()](src/modules/selfModeration/services/reactionTracker.js:262)
- 定时检查与流程推进: 
  - [javascript.checkActiveModerationVotes()](src/modules/selfModeration/services/moderationChecker.js:14)
  - [javascript.processIndividualVote()](src/modules/selfModeration/services/moderationChecker.js:50)
  - [javascript.executePunishment()](src/modules/selfModeration/services/moderationChecker.js:166)
- 禁言执行（频道覆盖）与解除:
  - [javascript.executeMuteUser()](src/modules/selfModeration/services/punishmentExecutor.js:211)
  - [javascript.getCurrentMuteDuration()](src/modules/selfModeration/services/punishmentExecutor.js:348)
- 禁言时长计算/“累加”框架:
  - [javascript.calculateMuteDuration()](src/modules/selfModeration/utils/timeCalculator.js:9)
  - [javascript.calculateAdditionalMuteDuration()](src/modules/selfModeration/utils/timeCalculator.js:38)
- 投票结束与结果公告:
  - [javascript.handleExpiredVote()](src/modules/selfModeration/services/moderationChecker.js:192)
  - [javascript.editVoteAnnouncementToExpired()](src/modules/selfModeration/services/moderationChecker.js:233)
  - 截止后删除消息 [javascript.deleteMessageAfterVoteEnd()](src/modules/selfModeration/services/punishmentExecutor.js:395)

