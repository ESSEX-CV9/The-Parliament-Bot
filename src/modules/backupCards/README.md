# 🎴 补卡管理系统

补卡管理系统是一个自动化工具，用于从Excel文件中读取补卡信息，并自动将角色卡文件发送到对应的Discord帖子中。

## 📋 功能特性

### 核心功能
- 📖 **Excel数据解析**: 自动读取和解析补卡Excel文件
- 🔍 **智能内容识别**: 自动识别文件、文字描述、Discord链接等不同类型的内容
- 📁 **文件智能定位**: 在多个目录中自动搜索和定位图片文件
- 🤖 **自动消息发送**: 自动生成embed消息并发送到指定帖子
- 📊 **实时进度跟踪**: 显示处理进度和统计信息
- 🧪 **测试模式**: 支持无实际发送的分析测试
- 📦 **自动归档**: 补卡完成后自动归档帖子，释放活跃线程数

### 支持的内容类型
1. **图片文件**: `.png`, `.jpg`, `.jpeg`, `.gif`
2. **JSON文件**: `.json`
3. **文字描述**: "作者自补", "网盘", "无需匹配"等
4. **Discord链接**: 包含discord.com的完整链接

## 🏗️ 系统架构

```
backupCards/
├── commands/           # 命令入口
│   ├── processBackupCards.js    # 主处理命令
│   └── testBackupCards.js       # 测试命令
├── services/           # 核心服务
│   ├── excelReader.js           # Excel读取服务
│   ├── fileLocator.js           # 文件定位服务
│   ├── messageProcessor.js     # 消息处理服务
│   └── progressTracker.js      # 进度跟踪服务
├── utils/              # 工具类
│   ├── contentAnalyzer.js      # 内容分析工具
│   └── embedGenerator.js       # 消息生成器
└── config/
    └── backupConfig.js          # 配置文件
```

## 🚀 使用方法

### 1. 测试系统功能
```
/testbackupcards [rows:数量]
```
- **rows**: 可选，测试的行数，默认5行，最大20行
- 用于验证Excel文件、图片目录、配置是否正确

### 2. 执行补卡处理
```
/processbackupcards [start:开始行] [count:处理数量] [testmode:测试模式] [autoarchive:自动归档] [excelfile:Excel文件路径]
```

#### 参数说明
- **start**: 可选，开始处理的行号（从1开始），默认从第1行开始
- **count**: 可选，处理的行数，默认处理全部，最大100行
- **testmode**: 可选，是否为测试模式（只分析不发送），默认false
- **autoarchive**: 可选，是否自动归档完成的帖子，默认使用配置文件设置
- **excelfile**: 可选，自定义Excel文件路径，默认使用配置文件中的路径

#### 使用示例
```bash
# 测试前5行数据
/processbackupcards testmode:true count:5

# 从第10行开始处理20行，启用自动归档
/processbackupcards start:10 count:20 autoarchive:true

# 处理所有数据，禁用归档
/processbackupcards autoarchive:false

# 使用自定义Excel文件，使用配置的归档设置
/processbackupcards excelfile:data/custom/backup_cards.xlsx
```

## ⚙️ 配置说明

### Excel文件格式要求
Excel文件应包含以下列（H-AL列）：
- **A列**: 帖子标题
- **B列**: 帖子ID  
- **C列**: 原帖子ID
- **D列**: 发帖人数字ID
- **E列**: 认领状态
- **F列**: 认领者数字ID
- **G列**: 完成状态
- **H列**: 2k图包的匹配结果
- **I-AL列**: 角色卡1-30

### 目录结构要求
```
data/backupCards/
├── 确认补卡项_带帖子ID_updated_20250703_010237.xlsx
├── pic/                    # 基础图片目录
│   ├── characters/         # characters子目录
│   └── [其他图片文件]
└── 类脑角色卡/              # 类脑角色卡目录
    ├── 男性视角/
    ├── 同人/
    └── [其他子目录和文件]
```

### 路径解析规则
1. **直接文件名**: 如`中文(374).png`，在`pic/`和`类脑角色卡/`目录中搜索
2. **characters前缀**: 如`characters\\JOJO_.png`，在`pic/characters/`中搜索
3. **其他路径前缀**: 如`男性视角\\纯爱\\卡卡\\2.png`，在`类脑角色卡/`对应子目录中搜索

## 📊 处理流程

### 1. 初始化阶段
- 读取Excel文件
- 验证数据格式
- 初始化文件缓存
- 设置进度跟踪

### 2. 内容分析阶段
对每个补卡项的内容进行分析：
- 识别内容类型（文件/文字/链接）
- 定位文件路径
- 验证文件存在性

### 3. 消息处理阶段
根据内容类型生成相应消息：
- **文件类型**: 发送embed说明 + 附件文件
- **文字描述**: 发送embed说明消息
- **Discord链接**: 发送embed说明 + 纯链接消息

### 4. 进度报告阶段
- 实时更新处理进度
- 统计各类型内容数量
- 记录错误和失败项
- 生成最终报告

## 🔧 配置参数

### 基础配置 (`config/backupConfig.js`)
```javascript
excel: {
    filePath: 'data/backupCards/确认补卡项_带帖子ID_updated_20250703_010237.xlsx',
    startColumn: 'H',        // 开始列
    endColumn: 'AL'          // 结束列
},
paths: {
    picDir: 'data/backupCards/pic',                    // 基础图片目录
    characterDir: 'data/backupCards/pic/characters',   // characters目录
    brainCardDir: 'data/backupCards/类脑角色卡'         // 类脑角色卡目录
},
discord: {
    baseUrl: 'https://discord.com/channels/1134557553011998840/',
    rateLimitDelay: 1000,    // 消息发送间隔（毫秒）
    batchSize: 10,           // 批处理大小
    autoArchive: {
        enabled: true,       // 是否启用自动归档
        reason: '补卡完成，自动归档以释放活跃线程数',  // 归档原因
        onlyOnSuccess: true, // 是否只在所有内容都成功处理后归档
        delay: 2000         // 归档前延迟（毫秒）
    }
}
```

## 🛡️ 权限要求

### 使用权限
需要以下任一身份组：
- 超级管理员
- 系统管理员  
- 运营管理

### 机器人权限
- 发送消息
- 上传文件
- 嵌入链接
- 读取消息历史
- 管理线程（用于自动归档功能）

## 📈 性能特性

### 优化措施
- **文件缓存**: 预加载目录文件列表，提高搜索效率
- **批处理**: 每10个项目暂停，避免频率限制
- **并发控制**: 合理的延迟和重试机制
- **内存管理**: 及时释放大文件内存

### 处理能力
- 支持每批最多100行数据
- 自动处理Discord交互超时
- 支持断点续传（通过start参数）

## 🚨 错误处理

### 常见错误及解决方案

1. **Excel文件不存在**
   - 检查文件路径配置
   - 确认文件名是否正确

2. **图片文件找不到**
   - 检查目录结构是否正确
   - 确认文件名大小写是否匹配

3. **Discord权限不足**
   - 检查机器人权限设置
   - 确认在目标频道有发送消息权限

4. **处理超时**
   - 减少单次处理的数据量
   - 使用分批处理

## 🔍 调试信息

### 日志记录
系统会在控制台输出详细的处理日志：
- Excel读取进度
- 文件搜索结果
- 消息发送状态
- 错误详情

### 统计信息
处理完成后会提供：
- 总处理项目数
- 成功/失败/跳过数量
- 各类型内容统计
- 处理耗时

## 📝 更新日志

### v1.0.0 (2025-01-12)
- ✨ 初始版本发布
- 🎯 支持Excel文件解析
- 📁 智能文件定位系统
- 🤖 自动消息发送功能
- 📊 实时进度跟踪
- 🧪 测试模式支持
- 📦 自动归档功能（释放活跃线程数）

## 🤝 技术支持

如遇到问题或需要功能改进，请联系系统管理员或在相应频道提出反馈。

---

**补卡管理系统 v1.0.0** | *让角色卡补充变得简单高效* 🎴 

# Discord 补卡管理系统

这是一个自动化的Discord补卡管理系统，能够从Excel文件读取补卡信息，自动将角色卡文件发送到指定的Discord帖子中，并支持自动归档功能。

## 功能特点

### 📋 Excel数据处理
- 自动读取Excel文件中的补卡数据
- 支持多种内容类型识别和处理
- 智能解析文件路径和Discord链接

### 🔍 智能内容识别
- **图片文件**: 如`中文(374).png`、`v2.png`
- **带路径文件**: 如`characters\JOJO_.png`、`男性视角\纯爱\卡卡\2.png`
- **文字描述**: 如"作者自补"、"网盘"、"无需匹配"
- **Discord链接**: 包含discord.com的完整链接

### 📁 智能文件定位
- **精确匹配**: 直接文件名首先在根目录中搜索（`\data\backupCards\pic`和`\data\backupCards\类脑角色卡`）
- **递归搜索**: 如果根目录未找到，自动递归搜索所有子目录（如`类脑角色卡\同人\姬子.png`）
- **路径前缀**: `characters`前缀在`\data\backupCards\pic\characters`中搜索
- **指定路径**: 其他路径前缀在`\data\backupCards\类脑角色卡`对应子目录中搜索

### 🚀 自动归档功能
- 补卡完成后自动归档帖子以释放活跃线程数
- 支持多种归档模式控制
- 完善的权限检查和错误处理

### 🧹 精确匹配与清理功能
- **精确匹配**: 只进行文件名的精确匹配，提高准确性
- **历史清理**: 批量清理历史模糊匹配的补卡消息
- **智能识别**: 自动识别模糊匹配消息进行清理
- **时间过滤**: 支持按时间范围清理历史消息

## Discord命令

### `/processbackupcards` - 补卡处理命令

主要的补卡处理命令，支持以下参数：

- `start` (整数，可选): 开始处理的行号，默认从第1行开始
- `count` (整数，可选): 处理的行数，默认处理全部，最大100行
- `testmode` (布尔，可选): 测试模式，只分析不实际发送消息，默认false
- `autoarchive` (布尔，可选): 自动归档设置，默认使用配置文件设置
- `allowarchiveintest` (布尔，可选): **新增**测试模式下允许归档，默认false
- `excelfile` (字符串，可选): 指定Excel文件路径，默认使用配置中的文件

#### 使用示例

```bash
# 基本使用 - 处理所有补卡
/processbackupcards

# 测试模式 - 只分析不发送
/processbackupcards testmode:true

# 测试模式 + 归档 - 分析内容但实际归档线程
/processbackupcards testmode:true allowarchiveintest:true

# 处理指定范围
/processbackupcards start:10 count:20

# 禁用自动归档
/processbackupcards autoarchive:false
```

### `/archivebackupthreads` - 批量归档命令

专门用于批量归档补卡线程的命令，支持以下参数：

- `start` (整数，可选): 开始处理的行号，默认从第1行开始
- `count` (整数，可选): 处理的行数，默认处理全部，最大100行
- `dryrun` (布尔，可选): 试运行模式，只检查线程状态不实际归档，默认false
- `excelfile` (字符串，可选): 指定Excel文件路径，默认使用配置中的文件

#### 使用示例

```bash
# 归档所有线程
/archivebackupthreads

# 试运行 - 检查状态不实际归档
/archivebackupthreads dryrun:true

# 归档指定范围
/archivebackupthreads start:1 count:50

# 使用自定义Excel文件
/archivebackupthreads excelfile:"path/to/your/file.xlsx"
```

### `/cleanupfuzzymatches` - 清理模糊匹配命令

专门用于清理历史模糊匹配补卡消息的命令，**支持自动处理已归档线程**，参数如下：

- `start` (整数，可选): 开始处理的行号，默认从第1行开始
- `count` (整数，可选): 处理的行数，默认处理全部，最大100行
- `dryrun` (布尔，可选): 试运行模式，只查找不实际删除，默认false
- `days` (整数，可选): 只删除指定天数前的消息，默认所有，最大30天
- `excelfile` (字符串，可选): 指定Excel文件路径，默认使用配置中的文件

#### 🔄 智能归档处理

该命令具备智能的归档处理能力：
- **自动解除归档**: 遇到已归档线程时，临时解除归档进行清理
- **清理完成归档**: 清理完成后自动重新归档线程
- **错误恢复**: 如果清理过程中出错，会自动恢复线程的归档状态
- **权限检查**: 确保机器人有足够权限进行归档操作

#### 使用示例

```bash
# 清理所有模糊匹配消息
/cleanupfuzzymatches

# 试运行 - 查找但不删除
/cleanupfuzzymatches dryrun:true

# 清理7天前的模糊匹配消息
/cleanupfuzzymatches days:7

# 清理指定范围的线程
/cleanupfuzzymatches start:1 count:50

# 组合使用
/cleanupfuzzymatches dryrun:true days:3 start:10 count:20
```

### `/testbackupcards` - 测试命令

快速测试系统功能的命令，无参数。

## 归档功能详解

### 自动归档模式

1. **配置文件控制**: 通过`config/backupConfig.js`中的`autoArchive`设置
2. **命令参数控制**: 通过`autoarchive`参数覆盖配置设置
3. **测试模式归档**: 通过`allowarchiveintest`参数在测试模式下启用归档

### 归档触发条件

- 补卡内容处理完成
- 线程未被归档
- 机器人有管理线程权限
- 满足配置的归档条件（如仅成功时归档）

### 专用归档功能

使用`/archivebackupthreads`命令可以：
- 批量检查线程状态
- 单独执行归档操作（不处理补卡内容）
- 试运行模式检查哪些线程可以归档
- 详细的归档统计和错误报告

## 配置说明

### 自动归档配置

在`config/backupConfig.js`中：

```javascript
autoArchive: {
    enabled: true,                    // 是否启用自动归档
    reason: '补卡完成，自动归档以释放活跃线程数',  // 归档原因
    onlyOnSuccess: true,              // 仅在全部成功时归档
    delay: 2000                       // 归档前延迟（毫秒）
}
```

## 使用场景

### 场景1: 正常补卡处理
```bash
/processbackupcards start:1 count:10
```

### 场景2: 测试内容但不发送
```bash
/processbackupcards testmode:true
```

### 场景3: 测试内容并归档线程
```bash
/processbackupcards testmode:true allowarchiveintest:true
```

### 场景4: 只归档不处理补卡
```bash
/archivebackupthreads start:1 count:50
```

### 场景5: 检查归档状态
```bash
/archivebackupthreads dryrun:true
```

### 场景6: 清理历史模糊匹配消息
```bash
/cleanupfuzzymatches dryrun:true days:7
```

### 场景7: 批量删除模糊匹配内容
```bash
/cleanupfuzzymatches start:1 count:100
```

## 🔍 文件搜索示例

### 递归搜索功能演示

**Excel中的内容**：`姬子.png`
**实际文件位置**：`\data\backupCards\类脑角色卡\同人\姬子.png`

**搜索过程**：
1. 首先在根目录搜索 ❌
2. 自动递归搜索所有子目录 ✅
3. 在 `类脑角色卡\同人\` 中找到文件
4. 显示匹配类型：`子目录搜索`

**输出效果**：
```
📸 角色卡补充
📁 文件信息
文件名: 姬子.png
位置: brainCard/同人
匹配类型: 子目录搜索
```

## 权限要求

- 超级管理员
- 系统管理员  
- 运营管理等身份组

## 错误处理

系统具有完善的错误处理机制：
- 文件未找到时提供详细说明
- 权限不足时给出友好提示
- 归档失败不影响补卡处理成功
- **智能恢复**: 清理过程中如果出错，自动恢复线程归档状态
- **分层统计**: 分别统计删除操作和归档操作的成功/失败情况
- 详细的错误日志和统计报告

## 技术特点

- **精确匹配**: 去除模糊匹配，只进行精确的文件名匹配，避免错误匹配
- **递归搜索**: 智能递归搜索所有子目录，无需手动指定路径即可找到深层文件
- **智能清理**: 自动识别并清理历史模糊匹配消息，保持频道整洁
- **高效处理**: 批量处理，智能频率控制
- **实时进度**: 详细的进度跟踪和统计
- **容错设计**: 单个失败不影响整体处理
- **权限安全**: 完善的权限检查机制
- **灵活配置**: 支持多种参数组合使用
- **时间控制**: 支持按时间范围进行操作，避免误删重要内容 