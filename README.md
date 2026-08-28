# @dsh-external/dsh-usage

DSH **Token 消耗体系**插件：把「正在花多少、一共花了多少、还剩多少」三件事装进一个插件。

- **实时（左徽标）**：对话头部左侧显示当前会话累计 Token 与费用，按**每条请求实际使用的模型 × 涨价时代 × 峰谷时段**逐桶计价，悬停看逐模型明细与上下文组成；
- **历史（设置页看板）**：扫描 `~/.dsh/sessions` 全部会话日志，按官方刊例精确折算全局账单——时间筛选、各模型花费折线图、模型/文件夹明细；
- **余量（右徽标 + 看板「订阅额度」板块）**：GLM / Kimi Coding Plan 的 5 小时/周/月/订阅周期额度进度条，模型切换自动对齐；设置页看板新增「订阅额度」板块，**当前 DSH 配置的全部 Coding Plan 一览无余**。

> 本插件是 `dsh-token-cost`、`dsh-usage-board`、`dsh-quota-visor` 三个插件的合并后继：
> 同一套计价内核、同一份日志解析、同一个配置文件，三个 UI 面零冲突互补。

## 安装

```bash
# 方式一：Release tgz 装进 profile（推荐）
# 下载 dsh-usage-<version>.tgz 后按 DSH 插件常规流程安装

# 方式二：源码构建
git clone https://github.com/nanami-0713/dsh-usage.git
cd dsh-usage
npm install && npm run build:all
# 然后用 super-injector 注入，或按 cordis.patch.yml 做 bundle 装配
```

## 从三个旧插件迁移（重要）

如果你正在使用 `dsh-token-cost` / `dsh-usage-board` / `dsh-quota-visor` 的任意组合：

1. **直接安装本插件**。四个插件可以同时存在，API 路由零冲突——但你会看到双份徽标/双设置页，属正常过渡状态。
2. **首次启动自动迁移**（无需手动操作）：
   - `~/.dsh/plugins/dsh-usage-board/config.json` 的计价覆盖、汇率
   - `~/.dsh/plugins/dsh-quota-visor/config.json` 的 provider 映射、轮询间隔
   合并写入 `~/.dsh/plugins/dsh-usage/config.json`（version 2）；旧文件改名为 `config.migrated.json` **保留备查，绝不删除**；
   - `dsh-usage-board/cache.json`（全量索引缓存）**复制**到新目录——旧插件在过渡期照常工作，新插件免全量重扫。
3. **验证**：对话头部左右徽标正常、设置页「用量看板」有数据、「订阅额度」板块列出你的 Coding Plan。
4. **卸载三个旧插件**（推荐）：`dsh plugin --profile web remove dsh-token-cost dsh-usage-board dsh-quota-visor`（或从 profile 的 bundles 中移除后重启）。
5. **回退**：卸载本插件，把两个 `config.migrated.json` 改回 `config.json` 即可，三个旧插件原样复活。

**API 兼容**：旧路径 `/api/dsh-token-cost/usage`、`/api/dsh-usage-board/*`、`/api/dsh-quota-visor/*` 会作为别名继续工作一个版本（旧 config API 自动做 v1↔v2 视图转换），第三方集成有充足迁移时间。

## 统一配置（`~/.dsh/plugins/dsh-usage/config.json`）

```json
{
  "version": 2,
  "rateUsdCny": 7.2,
  "models": {
    "my-model": { "currency": "CNY", "inputPerMillion": 1.0, "cacheReadPerMillion": 0.1, "outputPerMillion": 2.0, "label": "我的模型" }
  },
  "providers": {
    "my-custom-glm": { "adapter": "zai", "baseURL": "https://open.bigmodel.cn" },
    "some-payg-provider": { "adapter": "none" }
  },
  "refreshMs": 60000
}
```

- `models`：为计价目录外的模型补充官方单价（未收录模型 tokens 照计、费用不计，绝不套用别家价格）；
- `providers`：Coding Plan 适配器映射（`zai` / `kimi` / `none`）；官方内置 provider 与 baseURL 特征可自动识别，多数情况无需配置；
- API key 全程留在 host 侧（进程环境变量 → `~/.dsh/.credentials.yaml`），浏览器只经同源 API 取数。

## 内置计价目录（截至 2026-08 官方公开刊例）

| 模型 | 时代 | 单价（每百万 tokens） |
|---|---|---|
| DeepSeek V4 Flash | 涨价前 | 输入 ¥1.0 · 缓存 ¥0.02 · 输出 ¥2.0 |
| DeepSeek V4 Flash | 空闲 / 高峰 | 输入 ¥1.5/¥3.0 · 缓存 ¥0.05/¥0.10 · 输出 ¥4.5/¥9.0 |
| DeepSeek V4 Pro | 涨价前 | 输入 ¥3.0 · 缓存 ¥0.025 · 输出 ¥6.0 |
| DeepSeek V4 Pro | 空闲 / 高峰 | 输入 ¥4.5/¥9.0 · 缓存 ¥0.15/¥0.30 · 输出 ¥13.5/¥27.0 |
| Kimi K3（含 k3 等别名） | 不分时 | 输入 $3.0 · 缓存 $0.30 · 输出 $15.0 |
| GLM-5.3 | 不分时（**估算**，按 5.2 刊例） | 输入 ¥8 · 缓存 ¥2 · 输出 ¥28 |
| GLM-5.2 | 不分时 | 输入 ¥8 · 缓存 ¥2 · 输出 ¥28 |

DeepSeek 分时计价自北京时间 2026-08-17 00:00 起生效；高峰 = 每日 9:00-12:00、14:00-18:00（Asia/Shanghai）。

## Host API（前缀 `/api/dsh-usage/`）

| 路由 | 说明 |
|---|---|
| `GET /session?sessionId=<id>` | 单会话逐模型小时桶归集（实时徽标） |
| `GET /summary?range=1d\|7d\|30d\|all[&refresh=1]` | 全局用量汇总（看板） |
| `GET /pricing` | 计价目录视图（含用户覆盖） |
| `GET /quota?provider=<id>[&refresh=1]` | 单 provider 订阅额度（右徽标） |
| `GET /quota/all[?refresh=1]` | 全部 Coding Plan 额度（看板「订阅额度」板块） |
| `GET/PUT /config` | 统一配置 v2 |

## 扩展 Coding Plan 适配器

```ts
import { registerQuotaAdapter } from '@dsh-external/dsh-usage/lib/quota/service.js'

registerQuotaAdapter('my-plan', async (apiKey, baseURL) => ({
  adapter: 'my-plan',
  adapterLabel: 'My Coding Plan',
  primaryId: '5h',
  windows: [{ id: '5h', label: '5 小时额度', used: 10, limit: 100, unit: 'requests' }],
  fetchedAt: Date.now(),
}))
```

UI 只认统一的 `QuotaSnapshot` 模型（primary 窗口 + 任意附加窗口），新厂商只需实现响应翻译。

## 构建 / 测试

```bash
npm run build:all   # host tsc + client tsdown（依赖全部来自 npm）
npm run typecheck   # host + client 双端
npm test            # node:test 47 例（计价/索引/汇总/zstd/会话归集/配置迁移/quota）
```

## 架构

```
src/
├── core/            # 共享内核（三插件去重合并，各只一份）
│   ├── home.ts      # ~/.dsh 路径
│   ├── zstd.ts      # 多帧 zstd 解码
│   ├── session-log.ts  # 会话日志统一解析 + 双聚合器
│   ├── pricing.ts   # 计价目录/解析/折算 + 会话级聚合 + 格式化
│   └── config.ts    # 统一 config v2 + 旧配置迁移
├── session/         # 单会话归集（实时徽标后端）
├── board/           # 全局索引/汇总（看板后端）
├── quota/           # 订阅额度（适配器 + 识别 + 查询服务）
└── client/          # 三个 UI 面的统一入口
```

## License

MIT
