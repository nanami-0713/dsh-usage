# Changelog

## v1.2.0（2026-10-02）

### 新增

- 补入 **DeepSeek V4.1 Flash**（日志名 `deepseek-flash`，官方桌面端 DeepSeek Harness 的
  账户渠道 `deepseek-account` 与 API 渠道均记此名）：谷时输入 ¥1 / 缓存命中 ¥0.02 /
  输出 ¥4，峰时 ¥2 / ¥0.04 / ¥8。此前该模型 tokens 照计、费用按 0。
- 计价内核新增**工作日峰谷 + 法定节假日排除**口径：V4.1 Flash 的官方机制与 V4 系不同
  ——峰时仅周一至五（不含法定节假日），晚间/周末/节假日全天谷时。内置 2026 年国务院
  假日表（2027 年安排公布后需更新）；调休上班的周末按官方「周一至五」字面口径仍算
  谷时。V4 系维持每日峰谷口径不变。
- `CODING_PLAN_PROVIDER_HINTS` 补入 `deepseek-account`（官方桌面端账户渠道，费用为
  刊例价折算仅供参考）。

## v1.1.0（2026-10-02）

### 新增

- 计价目录扩容三家供应商（均为 2026-10 官方公开刊例，前瞻性支持——此前目录仅覆盖
  DeepSeek / Kimi / GLM 三系）：
  - **OpenAI**（美元）：GPT-6 Astra（$10/$50）、GPT-6.1 Sol（$2/$10）、GPT-6 Luna
    （$0.10/$0.50）、GPT-5.3 Codex（$1.75/$14）、GPT-5.2 含 gpt-5.2-codex 别名
    （$1.75/$14，上一代，历史日志兜底）、chat-latest（$5/$30）。GPT-6 系超长上下文档
    （约 2×）未细分，按标准短上下文价计。
  - **Anthropic**（美元）：Claude Fable 5（$10/$50）、Opus 5.5（$4/$20）、Opus 5
    （$5/$25）、Sonnet 5 / 5.5（$2/$10）、Haiku 4.5（$1/$5）。带日期后缀的快照 id
    （claude-opus-5-5-2026xxxx 等）由前缀匹配命中；claude-opus-5-5 排在 claude-opus-5
    之前防前缀抢占。
  - **小米 MiMo**（人民币，2026-05-27 调价后国内刊例）：V2.6 Pro（¥3/¥6）、V2.6 Flash
    （¥1/¥2）、V2.6 Pro UltraSpeed（¥30/¥60）；v2.5-pro / v2.5（2026-10-21 下线）同价，
    经别名命中。
- **缓存写独立计价**：`PriceEntry` / `ModelOverride` / 目录视图新增可选
  `cacheWritePerMillion`——OpenAI GPT-6 系与 Anthropic 全系的缓存写刊例价（1.25× 输入）
  由此精确计费，此前一律按输入价会系统性低估约 20-25%；未设置的模型沿用按输入价的
  历史行为，金额不受影响。会话徽标悬停单价行与看板价格明细同步展示「缓存写」档。

## v1.0.2（2026-09-30）

### 修复

- 计价目录补入 GLM-5.3-Flash / GLM-5.3-FlashX 官方刊例（[#1](https://github.com/nanami-0713/dsh-usage/issues/1)）：
  此前 `glm-5.3-flash` 靠 `glm-5.3-` 前缀匹配落进 GLM-5.3 估算价（¥8/¥2/¥28），现按
  bigmodel.cn 官方刊例独立命中——Flash 输入 ¥0.8 / 缓存命中 ¥0.23 / 输出 ¥2.8（约 5.3 的 1/10）、
  FlashX ¥2/¥0.57/¥7；两者须排在 glm-5.3 之前以免前缀匹配抢占。
- GLM-5.3 官方 API 刊例已公布（输入 ¥8 / 缓存命中 ¥2 / 输出 ¥28），移除「估算」标记，
  与原按 GLM-5.2 刊例的估算值恰好一致，历史折算金额不受影响。

## v1.0.0（2026-08-28）

`dsh-token-cost` + `dsh-usage-board` + `dsh-quota-visor` 三插件合并的首个版本。

### 合并

- 共享内核去重：多帧 zstd 解码、会话日志解析（request/header 归因 + last-wins usage）、
  计价目录（模型 × 时代 × 峰谷）、`~/.dsh` 路径工具、config 读写——各只保留一份
  （core/home、core/zstd、core/session-log、core/pricing、core/config）。
- 计价目录取两者并集：补入 glm-5.2 官方刊例；Kimi K3 别名并集（k3 / k3-256k / kimi-k3 / moonshot-k3）。
- 统一 config v2：计价覆盖（models/rateUsdCny）与额度映射（providers/refreshMs）合并到
  `~/.dsh/plugins/dsh-usage/config.json`；首次启动自动迁移两个旧插件配置，
  旧文件改名 `config.migrated.json` 保留；board 索引缓存【复制】复用，旧插件过渡期不受影响。

### 新增

- `GET /api/dsh-usage/quota/all`：枚举当前 DSH 配置的全部 provider，返回所有被识别为
  Coding Plan 的额度快照（未识别者仅计数不回显）。
- 设置页用量看板新增「订阅额度」板块：全部 Coding Plan 的窗口进度条 + 重置倒计时，
  与对话头部右徽标同源。
- `registerQuotaAdapter(id, fetcher)` 公开扩展点：第三方 Coding Plan 无需改源码接入。
- 实时费用徽标悬停卡增加「设置 · 用量看板」引导。

### 兼容

- 旧 API 路径别名（一个版本后移除）：`/api/dsh-token-cost/usage`、
  `/api/dsh-usage-board/summary|pricing|config`、`/api/dsh-quota-visor/quota|config`；
  旧 config API 自动做 v1 ↔ v2 视图转换。

### 测试

- 47 例 node:test 全绿：计价（时代/峰谷/多币种/覆盖/会话级聚合）、多帧 zstd、
  索引器增量缓存、汇总构建、会话归集、配置迁移与 v1 视图转换、
  provider 三级识别、zai/kimi 适配器解析、/quota/all 聚合。
