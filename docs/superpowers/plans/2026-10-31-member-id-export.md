# Member ID export implementation plan

**Goal:** 在现有 `/管理` 下实现安全、可恢复的全服成员 ID 导出，并提交 PR。

**Architecture:** 复用 discord.js REST、公共管理员鉴权、better-sqlite3 和受控 data 目录。独立 SQLite 表以事务提交每页 ID、计数和游标；独立异步服务恢复任务、生成并验证文件。管理命令只负责路由。

**Constraints:** 不改变关门/开门，不修改公共鉴权，不部署、不合并、不执行真实全服导出；所有测试使用本地临时目录和模拟 Discord REST。

**Approaches:** 清理任务管理器耦合消息删除且缺少原子分页状态；JSON+追加 TXT 需要额外崩溃恢复协议。选择项目已有 SQLite 依赖，以唯一键去重并原子提交游标，最终有界流式生成 TXT。此为实现者根据现有代码作出的选择。

## Tasks

- [x] 1. 测试并实现独立 store：任务唯一约束、事务分页、租约隔离、持久化恢复、保留期清理。文件 `src/modules/memberIdExport/services/exportStore.js`。
- [x] 2. 测试并实现后台服务：官方 REST 1000/after 分页、重试和超时、启动恢复、流式 TXT 与 SHA-256 校验、按附件限制分片。文件 `exportService.js`、`exportFiles.js`。
- [x] 3. 测试并集成 `/管理 成员id 检查|开始|状态|下载`、新交互重新鉴权、下载前强制刷新调用者；在现有 ready 生命周期中启动恢复。文件 `commands/memberIds.js`、`manageCommand.js`、`core/index.js`。
- [x] 4. 模拟 40 万成员压力测试、原有测试、自审修复、文档；由本分支交付 PR。

## Review focus

分页失败不得完成；短页继续到空页；非递增游标必须失败；数据库事务崩溃不会跳页；失去权限或跨服不可下载；完成文件损坏拒绝交付；进程竞争不能重复提交；临时文件不能无限积累；超限文件按完整行分片。

## Verification

先运行新增测试确认缺失行为，再实现并运行 `node --test tests/memberIdExport/*.test.js tests/selfModeration/*.test.js`。40 万压力测试使用生成式 REST fixture、不接触 Discord。记录真实命令输出和实际限制。

## Execution record

- 已验证：Node 22.23.4，92/92 测试（含子测试）通过；40 万 ID、401 请求、400 非空页、7,600,000 字节。
- 只读审查确认无跨服读取、事务跳页或旧功能变更；目录同步、未发布文件回收、下载锁异常三项已补充回归测试并修复。
- package.json、package-lock.json、公共鉴权、safetySetup、原有测试与基线一致。现有代码仅在管理路由及启动/收尾增加新功能接入。
- Node 24 原生依赖断言及真实 Discord 验证范围已在使用文档中说明；未改现有依赖、未访问线上成员 API。
- 按最终交付要求，新增测试仅在本地验证，不提交测试文件；原有测试保持不变。
