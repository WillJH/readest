# Fork 开发路线图

本 fork 的功能规划与进度记录。上游同步策略:fork `main` 始终镜像 `upstream/main`,功能分支独立开发。

## ✅ 已完成

| 功能 | 分支/提交 | 说明 |
|------|-----------|------|
| 生词本 | `feat/vocab-builder` | 查词收藏(全词典释义快照 + 语境句子)、笔记本内浏览、跳回原文(带进度保护)、`.nomedia` 媒体扫描隔离 |
| AI 多角色助手 | `feat/ai-characters` | 角色卡(人设 + 头像图库)、AI 自选头像(`[avatar:]` 协议)、分层提示词(全局系统提示词 + 用户指令) |
| 多模型连接 | `feat/ai-characters` | 连接档案管理、每角色绑定连接(coding plan 端点友好)、嵌入模型保持全局 |
| 背景图定时轮换 | `feat/ai-characters` | 间隔轮换、随机/顺序、自选图片池 |
| Readest Dev 安卓包 | 本地 | `com.bilingify.readest.dev` 独立包名,与官方客户端共存 |

## 🔜 排队中

### 1. 📋 人物卡 + 关系图谱「这是谁来着?」(AI 功能,规格已定,下一站)

**核心场景**:读外文长篇小说(尤其俄文名著类),人物多、名字陌生、隔几天回来记不住谁是谁。

**行为定义**:

- **用户手动调用**(不是自动弹出):随阅读进度演进,每次调用都基于"当前读到的地方"重新生成
- **AI 总结每个角色**:
  - 性格特质(personality)
  - 背景(background:出身、经历、动机)
  - 与其他已登场人物的关系
- **人物关系图**:可视化图谱,节点 = 人物,边 = 关系(带简述);随进度生长
- **防剧透是硬约束**:所有生成只允许使用**当前阅读位置之前**的内容(复用现有页码锁死机制),绝不能泄露后续剧情
- 人物登场位置记录(CFI),可跳回原文

**交互草案**:

- 入口:选中文本中的名字 → 工具条加"人物卡"动作;或侧栏/笔记本内的人物面板
- 人物卡弹层:当前进度下的人物小结 + 关系图 + 登场片段列表(可跳转)
- 数据按 (书, 进度区间) 缓存,重开书可复用

**依赖的现有基建**(边际成本低的原因):

- RAG 索引(legacy IDB / Reedy 检索,`spoilerBoundPosition` 页码上界现成)
- AI 连接系统 + 防剧透系统提示词(`buildSystemPrompt` 的 ABSOLUTE CONSTRAINTS)
- 跳转基建(`eventDispatcher navigate` + `goTo`)
- 图谱可视化:需选型(轻量方案优先,d3-force / cytoscape / 自绘 SVG)

**预估**:中等偏大(人物抽取质量是主要打磨点,图渲染次之)。

## 🧊 已搁置

### 陪伴模式(Companion Mode)——设计待成熟

完整原型曾实现于 `feat/companion-mode` 分支(触发器状态机 + 直连生成 + 气泡通知,全量测试绿),因整体设计尚不成熟主动撤下,主线不再包含。重启时可直接从该分支取材,经验教训:

- **架构结论(已验证)**:绕开 assistant-ui runtime、直连 provider 生成 + 写入自有会话存储 + 气泡通知的链路完全可行——无需运行时注入,该风险点已消解
- **待想清楚的问题**:触发时机与分寸感的规则化表达、"陪伴"与"打扰"的边界、消息价值的评估方式、省 token 策略;这些想清楚之前不做
- 代码资产:companionTrigger(纯函数+单测)、companionGenerator(直连生成,可复用于人物卡等按需生成场景)、CompanionBubble

## 💡 候选池(brainstorm 备档,未排期)

- 个人化前情提要:重开书时基于"你的"高亮/生词/停留位置生成 recap(非全书摘要)
- 广播剧朗读:对话说话人识别 + 多声线 TTS
- 渐进式辅助阅读:句子级难度挂翻译,随水平自动变稀("拆辅助轮")
- 生词本 → EPUB 词书:用 send/conversion 管线把生词+语境排版成真书
- 困惑热图:页面停留时长异常 → 被动收集难句 → 批量 AI 讲解
- 局域网共读:LocalSend 基建上的双端翻页同步

## 基建备忘

- 容器内安卓构建链已就位:JDK17 + rust(aarch64)+ SDK/NDK(`/opt/android-sdk`)+ 签名密钥(`/root/keys/readest-dev.keystore`),`gen/android` 的 applicationId 补丁为本地未提交状态
- web 开发命令:`API_BASE_URL=https://web.readest.com NEXT_DEV_ALLOWED_ORIGINS='...' pnpm dev-web -p 41790`
- 构建产物:`gen/android/app/build/outputs/apk/universal/release/`
