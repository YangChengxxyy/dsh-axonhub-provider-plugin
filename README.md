# dsh-axonhub-provider-plugin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件：把 [AxonHub](https://github.com/looplj/axonhub) 网关注册为模型 provider。与 [opencode-axonhub-provider-plugin](https://github.com/YangChengxxyy/opencode-axonhub-provider-plugin) 同功能。

- 自动发现模型列表：`GET {baseURL}/v1/models`（默认每 5 分钟刷新）
- 同时注册两种协议路由：`axonhub-openai`（OpenAI Chat Completions，`{baseURL}/v1`）和 `axonhub-anthropic`（Anthropic Messages，`{baseURL}/anthropic`）
- 元数据丰富：从 [models.dev](https://models.dev/) 匹配上下文/输出上限、推理能力、输入模态与显示名；api.json 磁盘缓存（`$XDG_CACHE_HOME/dsh-axonhub-provider-plugin/api.json`），匹配不到时回退内置启发式
- 思考强度：推理模型声明 `low` / `medium` / `high` / `xhigh` / `max` 档位，模型选择器的 Effort 菜单直接可用
- 热更新：通过 settings seam 写入 `llm-pi-ai` 的 volatile `providers` 配置，不用重启；路由出现在 **Settings → Models**，可编辑、可存 API key

## 安装

```sh
# 本地检出
dsh plugin --profile web add ./dsh-axonhub-provider-plugin

# 或 npm 发布后
dsh plugin --profile web add dsh-axonhub-provider-plugin
```

`--profile` 换成你的 profile 名（`dsh web` 默认是 `web`）。

## 配置 API key

插件路由声明的凭据引用默认为 `AXONHUB_API_KEY`，请求时经 dsh credentials 服务解析：

- **环境变量**：启动前 `export AXONHUB_API_KEY=ah-...`；或
- **Models 页面**：Settings → Models → 编辑 `AxonHub (OpenAI)` / `AxonHub (Anthropic)` provider → 填入 API key（写入 `$DSH_HOME/.credentials.yaml`，不写进配置文件）。

首次拉取需要凭据；拿不到时插件只告警不报错，下次刷新再试。

## 选项

在本插件 entry 的 `config` 里配置（profile 的 `cordis.patch.yml`，entry id 为 `axonhub`）：

```yaml
- id: axonhub
  config:
    baseURL: https://llm.cccloud.xin   # AxonHub 根地址，也可 !!js process.env.AXONHUB_BASE_URL
    apiKeyEnv: AXONHUB_API_KEY         # 凭据引用名
    piAiEntry: llm-pi-ai               # pi-ai 适配器的 entry id（自定义 profile 里改过才需要动）
    refreshMs: 300000                  # 模型列表刷新间隔；0 关闭周期刷新（启动仍拉一次）
    modelsDev: true                    # models.dev 元数据丰富；false 只用内置启发式
```

注意：profile patch 对 entry 的 `config` 是**整体替换**，写 `config:` 时要把要保留的字段一并写上。

## 工作方式

本插件不写代码里的 provider，而是把 AxonHub 网关建模成 `@deepseek-ai/dsh-llm-pi-ai` 的两条"hand-declared route"（产品 profile 里 `llm-pi-ai` 默认休眠挂载）。每次刷新：

1. 抓 `/v1/models`，结合 models.dev 生成 pi-ai 模型档案（`contextWindow` / `maxTokens` / `input` / `reasoningEfforts`）；
2. 路由缺失 → 写完整 profile（`api` / `baseURL` / `apiKeyEnv` / `displayName` / `models`）；路由已存在 → 只替换 `models` 列表，你在 Models 页面对其它字段的修改不会被覆盖；
3. `llm-pi-ai` 的 volatile 配置更新即时生效——模型列表、key、端点改动都作用于下一次请求。

在插件运行期间从 Models 页面**删除** `axonhub-*` 路由不会被重建（视为有意删除）；重启 dsh 后插件会重新写入。

与 opencode 版的差异：dsh 的模型档案没有价格字段，`pricing` 选项因此不存在；`/connect` 集成对应 dsh 的 credentials/Models 页面机制，由 `apiKeyEnv` 引用实现。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit（JSDoc checkJs）
```

## 调试

```sh
dsh --profile web --dump-config   # 确认 axonhub entry 已插入
```

Settings → Models 出现 `AxonHub (OpenAI)` 与 `AxonHub (Anthropic)` 即注册成功；模型列表为空时先看日志里 `[axonhub]` 的告警（多半是凭据未配置）。
