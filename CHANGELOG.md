# Changelog

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
