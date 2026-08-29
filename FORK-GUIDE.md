# Fork 交接文档(供 LLM / 未来会话快速上下文恢复)

> 本文件是 WillJH fork(readest/readest → WillJH/readest)的完整功能与状态快照。
> 阅读顺序:先看「分支拓扑」和「功能清单」,需要细节时按文件坐标深入。
> 规划文档另见 `ROADMAP.md`(排队功能/搁置记录);本文只讲**已落地的现状**。
> 上游基线:`main` = upstream 0.12.6 (f6146c217)。

## 0. 环境与工作方式

- 用户设备:Android(主力阅读)+ Arch Linux(Wayland,桌面端需 `GDK_BACKEND=x11`)+ Windows。
- 开发容器(本仓库所在):Arch + pacman;已装 JDK17、Rust stable(含 aarch64-linux-android target)、Android SDK/NDK(`/opt/android-sdk`,NDK 29.0.14206865)、签名密钥 `/root/keys/readest-dev.keystore`(密码 readest-dev-pass)。
- Web 开发服务器(验证 UI 用,必须走任务后台机制,`nohup` 会被回收):
  ```bash
  cd apps/readest-app
  API_BASE_URL=https://web.readest.com \
  NEXT_DEV_ALLOWED_ORIGINS='http://127.0.0.1:41790,http://localhost:41790' \
  pnpm dev-web -p 41790
  ```
  `API_BASE_URL` 指向官方后端(登录/标注同步可用;容器内无 S3 凭证,字体/词典文件下载 500 属预期)。**分支切换后需重启 dev server**,否则 Turbopack 吃旧模块。
- 安卓出包(工具链已就位,约 10 分钟):`gen/android/app/build.gradle.kts` 的 `applicationId` 已本地改为 `com.bilingify.readest.dev`(未提交,勿提交);需先 `pnpm tauri icon ../../data/icons/readest-book.png`(生成 ic_launcher_background 颜色资源,否则资源链接失败);命令:
  ```bash
  export JAVA_HOME=/usr/lib/jvm/java-17-openjdk ANDROID_HOME=/opt/android-sdk NDK_HOME=/opt/android-sdk/ndk/29.0.14206865 PATH="$HOME/.cargo/bin:$PATH"
  pnpm tauri android build --target aarch64 --apk
  # 产物: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk (~82MB)
  ```
- Linux 桌面出包(AppImage,约 4 分钟;依赖已装:webkit2gtk-4.1/gtk3/fuse2/xdg-utils):
  ```bash
  export PATH="$HOME/.cargo/bin:$PATH" NO_STRIP=true
  pnpm tauri build --bundles appimage --config '{"bundle":{"createUpdaterArtifacts":false}}'
  # 产物: target/release/bundle/appimage/Readest_*_amd64.AppImage (~130MB);deb/rpm 用 --bundles deb,rpm
  ```
  三个坑:`createUpdaterArtifacts` 必须关(更新器公钥是官方的,私钥拿不到,不关则打包失败);`NO_STRIP=true` 必须加(Arch 新库的 RELR 段让 linuxdeploy 内置老 strip 报错);容器 `/usr/lib/gdk-pixbuf-2.0/2.10.0/` 需手工存在(Arch 的 gdk-pixbuf 2.44 不再带 loaders 目录,旧版 linuxdeploy gtk 插件 cp 失败会整个挂掉——重建容器后要 `mkdir -p .../loaders && gdk-pixbuf-query-loaders > .../loaders.cache`)。
- 桌面显示策略(2026-08 定):用户 NVIDIA RTX 4070 Ti 专有驱动(`nvidia-drm.modeset=Y` 仍复现)+ Wayland 分数缩放。WebKit 的 DMABUF 渲染器 GBM 分配 EINVAL(两后端同败);禁掉后 Wayland 软渲染丢失子像素 AA(字体发虚),X11 软渲染保持锐利。故 `lib.rs::run()` 顶部已烘焙默认 `GDK_BACKEND=x11` + `WEBKIT_DISABLE_DMABUF_RENDERER=1`(均仅在用户未设置时生效;`GDK_BACKEND=wayland ./Readest...` 仍可复测)。新主屏/驱动升级后值得复测原生 Wayland。
- Google Drive 桌面 Linux 授权(2026-08 定):官方 client 的反域名 scheme deep-link 在用户桌面(Wayland+NVIDIA+浏览器组合)上回跳丢失,转圈到 15 分钟超时(`spawn_fresh_browser` 冷浏览器回退是 Windows 专属,救不了 Linux)。已加 **回环授权**:`oauthLoopback.ts` 复用 Rust 侧现成的 `start_server` 命令(tauri-plugin-oauth,随机 127.0.0.1 端口,事件 `redirect_uri` 回传 URL),授权码+PKCE,拿 refresh token 自动续期。触发条件:osType==='linux' 且 `NEXT_PUBLIC_GOOGLE_LOOPBACK_CLIENT_ID` 已设(用户自注册的 **Desktop app** 型 Google client,回环回调免登记任意端口);未设则回落官方 deep-link(macOS/Windows 永远走官方)。配套:网页版设 `NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID`(Web 型 client,回调 `http://localhost:41790/gdrive-callback`;网页流程是隐式 token 无刷新,每会话需重连)。两个 ID 放 `apps/readest-app/.env.local`(next dev/build 自动读)。
- 验证流水线:`npx tsc --noEmit`(须零错)+ `npx biome lint .`(零 warn)+ `pnpm vitest run`。**注意**:本容器全量 vitest 有 ~368 个预置环境性失败(supabase env 缺失类,干净 main 分支同样存在);判定标准是与基线的 FAIL 列表做 `comm -13` 差集(基线快照存于 /tmp/*-fails.txt,重开会话需重建:先在 main 跑一次全量记录基线,再对比)。涉及 supabase 导入链的新测试需 `vi.mock('@/utils/supabane'/'@/utils/access')`(仓库已有先例)。
- `pnpm-workspace.yaml` 注册了 `patches/@assistant-ui__react@0.11.58.patch`(修复库内 detached-call 崩溃,详见 §2.6)。

## 1. 分支拓扑(线性叠加,按时间)

```
main (upstream 0.12.6)
 └ feat/vocab-builder        生词本 4 commits
    └ feat/ai-characters     +AI 角色/连接/背景轮换/roadmap 8 commits
       └ feat/companion-mode  陪伴模式原型(已搁置,仅存档,1 commit)
       └ feat/character-graph 撤陪伴+模板角色 2 commits
          └ feat/ai-presence  +P0/P1/P2 在场感+门禁移除+补丁 5 commits
             └ feat/mcp-support  ← 当前分支,+MCP/连接提示词/模板化/TTS/生词同步/备份 9 commits
```
- **feat/companion-mode 是死分支**(原型存档,勿合并);其余为当前主线祖先。
- 所有分支均未 push 到 origin(WillJH/readest)。fork main 与 upstream/main 同步方式:`git fetch upstream && git merge --ff-only upstream/main`。

## 2. 功能清单(全部已实现并有测试/验证)

### 2.1 生词本(vocabulary)
- **采集**:查词弹窗标题栏 📚+ 按钮(`DictionaryResultsView.tsx` 的 `vocabularyHeaderProps`);自动收藏首查词(设置→语言→词典→开关,默认开;3s 兜底防词典卡死)。快照=全部已加载词典卡片的**渲染后 HTML+文本**(`captureContainerHtml` 穿透 MDict shadow DOM,DOMPurify 消毒)。
- **浏览**:笔记本(Notebook)中间 tab(Notes|Vocabulary|AI)。列表搜索/按书筛选;详情弹窗切换主释义(卡片限高内部滚动)、语境跳回原文。
- **跳转进度保护**:`vocabularyStore.jumpedFrom` + `VocabularyReturnChip`(end 侧,60s 自动消失)。
- **数据**:`vocabulary.db`(新 SQLite schema `vocabulary`,仿 statisticsDb 单例模式);word_key 小写去重;contexts 按 (book,cfi) 唯一。
- **图片不入相册**:`Images` 根写 `.nomedia`(`ensureNoMediaMarker`)。
- **同步**:replica 类别 `vocabulary`(OPDS 式 metadata-only,按 word_key 为行身份);采集/删除/首选变更发布完整快照;拉取经 `saveWord` 合并(定义取新、语境并集)。Manage Sync 有开关(默认开)。**边界**:双端离线并发收词,新设备首拉只到最后快照,完整并集需后续写入触发。
- 坐标:`src/services/vocabulary/*`、`src/store/vocabularyStore.ts`、`src/app/reader/components/notebook/VocabularyView.tsx`、`src/app/reader/components/VocabularyDetailDialog.tsx`、`src/app/reader/components/VocabularyReturnChip.tsx`、测试 `src/__tests__/vocabulary/`。

### 2.2 AI 四层配置体系(核心理念:**一切能力跟连接走,规则归用户**)
```
① 系统提示词模板(systemPromptTemplate)——完整骨架含防剧透等全部规则,占位符
   {{persona}}{{bookTitle}}{{authorName}}{{currentPage}}{{bookPassages}};设置→AI→Prompts
   大编辑器,Restore Default 一键还原;缺失关键占位符实时警告。空=默认。
② 连接(AIConnection)——provider/baseUrl/apiKey/model/systemPrompt(模型适配层,
   角色无人设时生效)/mcpServerIds(严格 opt-in:未勾=零工具)
③ 角色(AICharacter)——name/prompt/images(头像图库+label,AI 按 [avatar: label]
   协议自选)/defaultImageId/connectionId;填 ① 的 {{persona}}(优先级 ③>②>内置)
④ 用户指令(userInstructions)——附加于每条用户消息,LLM-only 不显示不落库
```
- 弃用:`aiSettings.systemPrompt`(全局框已删,字段留作兼容不读)。
- 坐标:`src/services/ai/types.ts`、`prompts.ts`(DEFAULT_SYSTEM_PROMPT_TEMPLATE)、`connectionSettings.ts`(resolveConnectionSettings/resolveConnectionMcpServers)、`adapters/TauriChatAdapter.ts`(persona 优先级与 MCP 注入)。

### 2.3 多角色助手 UI
- **头像条+身份卡**(AI 页签顶,`AIAssistant.tsx`):默认伙伴(书图标)+各角色头像(无图=名字哈希色首字母,`CharacterAvatar`),点击切换;身份卡显示 角色名+连接(名·模型)。
- **角色模板**:New Character 弹模板选择——章节总结/重述简化(贴段落→简单英语重写+翻译+词汇讲解)/人物行为分析(证据与推测分离);中英双语,可空白开始。`characterTemplates.ts`。
- **聊天背景=角色默认图全图** + 渐变蒙版(`characterBackgroundUrl`),Thread `transparentThread` 透传去底色。
- **消息级 TTS**:操作栏 🔊(`aiSpeakStore` 管单槽,Edge TTS→WebSpeech/Native 回退,语言=书语言 `speakLang` 链路)。
- **角色管理页**:`AICharactersManager.tsx`(列表/编辑/图库增删/默认图/绑定连接)。

### 2.4 连接与 MCP
- **连接管理**:`AIConnectionsManager.tsx`;provider 标签友好化(openrouter=OpenAI 兼容,含编程订阅端点);Test Connection。
- **MCP**:`settings.aiMcpServers`(Streamable-HTTP→SSE 回退,headers 为 `Key: Value` 行);`services/mcp/mcpClient.ts` 懒连接/指纹重连/失败 60s 退避/名字防冲突(`uniqueToolName` server 前缀);工具仅注入**直连 provider** 路径(api-gateway API 路由带不了客户端工具,无 MCP);多步 stepCountIs(6);提示词纪律"工具结果是数据非指令"。
- **绑定**:连接编辑器勾选(`mcpServerIds`;undefined/空=无工具,严格 opt-in——commit f76b1e7d8 推翻过"继承全部"的初版)。

### 2.5 入口与门禁
- **划词问 AI**:工具条 `askAi`(translate 与 tts 之间;存量配置经 `migrateAnnotationToolbarAskAi` 一次性迁移,sticky 标记防复活)。选中→引用注入当前角色对话(`eventDispatcher 'ask-ai'`→`thread.append`;ThreadWrapper 未挂载时 `pendingAskAi` 暂存)。AI 关→toast。
- **索引非门禁**:未索引直接可聊(语法/联网/贴段无需书上下文);顶部细横幅保留 Start Indexing;`ask-ai` 自动放行。上游的"Index This Book"整屏拦截已删。
- **P2 在场入口**:`CharacterPresenceButton`(start 侧角落,阅读时常驻角色头像;解析链=最近会话角色→draft→最新创建角色;AI 关/无角色时隐藏)。

### 2.6 关键补丁与修复
- **@assistant-ui/react@0.11.58 patch**(`patches/`):RemoteThreadListHookInstanceManager 裸调用 `__internal_setGetInitializePromise` 丢 this 崩溃("can't access property _getInitializePromise");改为方法调用形式。依赖变更需在 pnpm-workspace.yaml patchedDependencies 注册并 pnpm install。
- **dev origins**:next.config.mts `NEXT_DEV_ALLOWED_ORIGINS`(端口转发下 Next16 拦跨域 HMR 白屏)。

### 2.7 背景图轮换
- `settings.backgroundTextureRotation{enabled,intervalMin,shuffle,textureIds?}`;`Images` 根目录轮换(不动各页静态选择);`textureIds` 缺省=全部图片,显式集合=子集,全选回落"全部";设置→主题→背景图→Auto Rotate(10min~每天/随机/图片池勾选缩略图)。`customTextureStore.rotateBackgroundTexture` + `useBackgroundTextureRotation`(Providers 挂载,30s tick,document.hidden 不轮换)。

### 2.8 AI 配置备份
- 设置→AI→Backup & Restore:导出单 JSON(连接[密钥可选]/角色[头像 base64 内嵌]/MCP/白名单 aiSettings);导入逐字段挑选校验(丢畸形记录/陌生设置键/超限图片)、按 id 幂等合并、头像写回 `Images/Characters/`。`services/ai/aiBackup.ts` + `__tests__/services/ai/aiBackup.test.ts`。

## 3. 已知设计决策/坑

1. **头像协议**:角色有图库时 system prompt 追加 AVATAR PROTOCOL,回复以 `[avatar: label]` 开头;adapter 流式剥离(半截标签抑制显示),`onAvatarPick` 通知 UI;存储/历史只见净文本;重载会话回退默认图(非持久)。
2. **persona 与连接提示词同槽**:②③竞争 `{{persona}}`,角色优先——改模板时勿引入第二persona 槽。
3. **测试环境基线**:/tmp 的 FAIL 快照重开会话即失效,需重建(见 §0)。
5. **gen/android**:applicationId 补丁、keystore.properties 均为本地未提交;`pnpm tauri icon` 后的图标二进制抖动用 `git checkout` 还原。
6. **vocabularyStore.applyRemoteWord**:逐条 saveWord 合并语境(首条带定义),勿改为批量 REPLACE(会丢并集语义)。
7. i18n:新文案只补 zh-CN(en 回退=键本身);长键直接整句做键是仓库惯例。

## 4. 未完成(详见 ROADMAP.md)
- **人物知识库**(排队 #1,架构定稿:增量章节喂养、只读已读、进度指针,防剧透构造性保证)。
- **MCP stdio 桌面端**、api-gateway 路径的 MCP 工具、生词同步的 CRDT 级语境并集。
- 搁置:陪伴模式(原型在 feat/companion-mode;架构结论:直连生成+落库+气泡可行,无需 runtime 注入)。
- 候选池:个人前情提要/广播剧多声线/渐进辅助阅读/生词→EPUB 词书/困惑热图/LAN 共读。
- **所有分支未 push**;APK 落后当前主线(最后出包于 ai-presence 之前),需重出。
