/**
 * AxonHub provider plugin for DeepSeek Harness (dsh).
 *
 * dsh 内置的 `@deepseek-ai/dsh-llm-pi-ai` 适配器以 entry id `llm-pi-ai` 休眠
 * 挂载在产品 profile 里：本插件周期性抓取 AxonHub 网关的 `GET {baseURL}/v1/models`，
 * 按 models.dev 元数据（上下文/输出上限、推理能力、输入模态）与内置启发式生成
 * pi-ai 模型档案，经 settings seam 写入 `llm-pi-ai` 的 volatile `providers` 配置，
 * 注册 `axonhub-openai`（OpenAI Chat Completions）与 `axonhub-anthropic`
 * （Anthropic Messages）两条 provider 路由——无需重启、可在 Settings → Models
 * 页面查看与编辑。
 *
 * 写入语义：路由缺失时写完整 profile（api/baseURL/apiKeyEnv/displayName/models）；
 * 路由存在时只替换 `models` 列表，用户在 Models 页面对其它字段的修改在刷新间保留；
 * 插件运行期间被用户删除的路由不会重建（重启 dsh 后会重新写入）。
 *
 * Options（cordis.patch.yml 中本插件 entry 的 config）：
 *   baseURL    - AxonHub 根地址，默认 https://llm.cccloud.xin（!!js env 也可用）
 *   apiKeyEnv  - 凭据引用名，默认 AXONHUB_API_KEY；经 credentials 服务解析
 *                （Models 页面可为该引用存 key），无该服务时读同名环境变量
 *   piAiEntry  - pi-ai 适配器的 entry id，默认 llm-pi-ai
 *   refreshMs  - 模型列表刷新间隔，默认 300000；0 关闭周期刷新（仍会在启动时拉一次）
 *   modelsDev  - 是否用 models.dev 元数据丰富模型（默认 true，失败回退启发式）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */

export const name = 'axonhub-providers'

export const Config = Schema.object({
  baseURL: Schema.string().default('https://llm.cccloud.xin'),
  apiKeyEnv: Schema.string().default('AXONHUB_API_KEY'),
  piAiEntry: Schema.string().default('llm-pi-ai'),
  refreshMs: Schema.natural().default(300_000),
  modelsDev: Schema.boolean().default(true),
})

/** @typedef {{ baseURL: string, apiKeyEnv: string, piAiEntry: string, refreshMs: number, modelsDev: boolean }} Options */

const PROVIDER_OPENAI = 'axonhub-openai'
const PROVIDER_ANTHROPIC = 'axonhub-anthropic'

const MODELS_DEV_API = 'https://models.dev/api.json'
const MODELS_DEV_CACHE = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
  'dsh-axonhub-provider-plugin',
  'api.json',
)

/** 思考强度档位：key 为 pi-ai thinking level，value 为线上拼写（reasoning_effort 等）。 */
const REASONING_EFFORTS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/** Model-ID substring heuristics: reasoning-capable model families (fallback). */
const REASONING_MATCHERS = [
  /^(o[134](-mini)?|gpt-5|gpt-6)/, // OpenAI
  /^claude-(opus|sonnet|haiku)/, // Anthropic
  /^glm/, // Zhipu
  /^deepseek/,
  /^(kimi|moonshot)/i,
  /^minimax/i,
  /^grok/,
  /^qwen/,
  /^(step|doubao|seed)/i,
  /^(mimo|muse)/i,
]

/** @param {string} id */
function supportsReasoning(id) {
  const lower = id.toLowerCase()
  return REASONING_MATCHERS.some((re) => re.test(lower))
}

/** Rough per-family context/output limits; unknown models get conservative defaults (fallback). */
const LIMITS = [
  { match: /^claude-(opus|sonnet)-?5/, context: 200_000, output: 64_000 },
  { match: /^claude/, context: 200_000, output: 32_000 },
  { match: /^gpt-6|^o[134]/, context: 400_000, output: 128_000 },
  { match: /^gpt-5/, context: 400_000, output: 128_000 },
  { match: /^glm/, context: 200_000, output: 128_000 },
  { match: /^deepseek/, context: 164_000, output: 64_000 },
  { match: /^(kimi|moonshot)/i, context: 256_000, output: 64_000 },
  { match: /^minimax/i, context: 1_000_000, output: 128_000 },
  { match: /^grok/, context: 256_000, output: 128_000 },
  { match: /^qwen/, context: 262_000, output: 64_000 },
]

/**
 * @param {string} id
 * @returns {{ context: number, output: number }}
 */
function limitsFor(id) {
  const lower = id.toLowerCase()
  for (const l of LIMITS) if (l.match.test(lower)) return { context: l.context, output: l.output }
  return { context: 128_000, output: 32_000 }
}

/** @typedef {{ id: string, created?: number }} AxonHubModel */

/**
 * @param {string} baseURL
 * @param {string} apiKey
 * @returns {Promise<AxonHubModel[]>}
 */
async function fetchModels(baseURL, apiKey) {
  const res = await fetch(`${baseURL}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`AxonHub model list failed: ${res.status} ${await res.text().catch(() => '')}`)
  const body = /** @type {{ data?: AxonHubModel[] }} */ (await res.json())
  return body.data ?? []
}

// ---------------------------------------------------------------------------
// models.dev enrichment
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DevModel
 * @property {string} [name]
 * @property {boolean} [reasoning]
 * @property {boolean} [tool_call]
 * @property {{ context?: number, output?: number }} [limit]
 * @property {{ input?: string[], output?: string[] }} [modalities]
 */

/**
 * Normalize an id for fuzzy equality: case, and `4.5` vs `4-5` version styles.
 * @param {string} id
 */
function norm(id) {
  return id.toLowerCase().replaceAll('.', '-')
}

/** @typedef {{ provider: string, key: string, nkey: string, dev: DevModel }} DevEntry */

class ModelsDevIndex {
  /** @param {DevEntry[]} entries */
  constructor(entries) {
    /** @type {Map<string, DevEntry[]>} */
    this.exact = new Map()
    /** @type {Map<string, DevEntry[]>} */
    this.suffix = new Map()
    for (const e of entries) {
      push(this.exact, e.nkey, e)
      const slash = e.nkey.lastIndexOf('/')
      if (slash >= 0) push(this.suffix, e.nkey.slice(slash + 1), e)
    }
  }

  /**
   * Resolve metadata for a bare model id. Preference: canonical vendors,
   * then any provider (exact key, then `vendor/id` suffix).
   * @param {string} id
   * @returns {DevModel | undefined}
   */
  lookup(id) {
    const n = norm(id)
    const hits = [...(this.exact.get(n) ?? []), ...(this.suffix.get(n) ?? [])]
    if (hits.length === 0) return undefined
    const order = [
      'anthropic', 'openai', 'zai', 'zhipuai', 'deepseek', 'minimax',
      'moonshotai', 'xai', 'stepfun', 'xiaomi', 'google',
    ]
    for (const p of order) {
      const hit = hits.find((h) => h.provider === p)
      if (hit) return hit.dev
    }
    return hits[0].dev
  }
}

/**
 * @param {Map<string, DevEntry[]>} map
 * @param {string} key
 * @param {DevEntry} e
 */
function push(map, key, e) {
  const list = map.get(key)
  if (list) list.push(e)
  else map.set(key, [e])
}

/** @param {Record<string, { models?: Record<string, DevModel> }>} body */
function parseModelsDev(body) {
  /** @type {DevEntry[]} */
  const entries = []
  for (const [provider, info] of Object.entries(body)) {
    for (const [key, dev] of Object.entries(info.models ?? {})) {
      if (dev.limit?.context || dev.modalities || dev.reasoning !== undefined) {
        entries.push({ provider, key, nkey: norm(key), dev })
      }
    }
  }
  return new ModelsDevIndex(entries)
}

async function readModelsDevCache() {
  try {
    return parseModelsDev(JSON.parse(await readFile(MODELS_DEV_CACHE, 'utf8')))
  } catch {
    return undefined
  }
}

/** @param {string} text */
async function writeModelsDevCache(text) {
  try {
    await mkdir(dirname(MODELS_DEV_CACHE), { recursive: true })
    await writeFile(MODELS_DEV_CACHE, text)
  } catch (err) {
    console.error('[axonhub] models.dev cache write failed:', err)
  }
}

/** @returns {Promise<ModelsDevIndex | undefined>} */
async function fetchModelsDev() {
  try {
    const res = await fetch(MODELS_DEV_API)
    if (!res.ok) throw new Error(`${res.status}`)
    const text = await res.text()
    const index = parseModelsDev(JSON.parse(text))
    void writeModelsDevCache(text)
    return index
  } catch (err) {
    console.error('[axonhub] models.dev fetch failed, keeping cached data / heuristics:', err)
    return undefined
  }
}

/**
 * Build one pi-ai model profile from a remote listing entry.
 * @param {AxonHubModel} m
 * @param {ModelsDevIndex | undefined} devIndex
 */
function buildModel(m, devIndex) {
  const meta = devIndex?.lookup(m.id)
  const limit = meta?.limit?.context
    ? { context: meta.limit.context, output: meta.limit.output ?? 64_000 }
    : limitsFor(m.id)
  const reasoning = meta ? meta.reasoning === true : supportsReasoning(m.id)
  /** @type {string[]} */
  const input = (meta?.modalities?.input ?? []).filter((m2) => m2 === 'text' || m2 === 'image')
  return {
    id: m.id,
    name: meta?.name ?? m.id,
    contextWindow: limit.context,
    maxTokens: limit.output,
    input: input.length ? input : ['text'],
    ...(reasoning ? { reasoningEfforts: { ...REASONING_EFFORTS } } : {}),
  }
}

/**
 * @param {Context} ctx
 * @param {Options} config
 */
export function apply(ctx, config) {
  const opts = /** @type {Options} */ (config)
  const baseURL = opts.baseURL.replace(/\/+$/, '')
  const credRef = opts.apiKeyEnv
  const ns = opts.piAiEntry
  const log = ctx.logger ?? console

  /** pi-ai provider profiles，key 为路由名。baseURL 按协议分别拼。 */
  const routes = {
    [PROVIDER_OPENAI]: {
      displayName: 'AxonHub (OpenAI)',
      api: 'openai-completions',
      baseURL: `${baseURL}/v1`,
      // 网关按 OpenAI 方言发送思考强度（reasoning_effort）。
      compat: { thinkingFormat: 'openai' },
    },
    [PROVIDER_ANTHROPIC]: {
      displayName: 'AxonHub (Anthropic)',
      api: 'anthropic-messages',
      baseURL: `${baseURL}/anthropic`,
    },
  }

  const state = {
    /** @type {AxonHubModel[]} */
    models: [],
    /** @type {ModelsDevIndex | undefined} */
    devIndex: undefined,
    /** 本插件写入过完整 profile 的路由。 */
    installed: new Set(),
    /** 用户删除后不再重建的路由。 */
    deleted: new Set(),
    /** 上次写入的 patch 序列化，用于去重。 */
    lastPatch: '',
    syncing: false,
    disposed: false,
    warnedSettings: false,
  }

  /** 解析凭据引用：credentials 服务（Models 页面存的 key / 环境继承）→ 进程环境变量。 */
  const resolveKey = async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credRef).catch(() => undefined)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    const env = process.env[credRef]
    return env && env.length > 0 ? env : undefined
  }

  const sync = async () => {
    if (state.syncing || state.disposed) return
    state.syncing = true
    try {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        if (!state.warnedSettings) {
          log.warn('[axonhub] settings service 不可用：当前 profile 没有 Settings/Models 集成，插件无法写入 provider 路由')
          state.warnedSettings = true
        }
        return
      }

      const key = await resolveKey()
      if (key === undefined) {
        if (state.models.length === 0) {
          log.warn(`[axonhub] 找不到凭据 ${credRef}：请在 Settings → Models 为 AxonHub 路由保存 API key，或导出环境变量 ${credRef}`)
        }
      } else {
        try {
          state.models = await fetchModels(baseURL, key)
        } catch (err) {
          log.warn('[axonhub] 拉取模型列表失败，保留已有列表：', err)
        }
      }
      if (opts.modelsDev && state.devIndex === undefined) {
        state.devIndex = await readModelsDevCache()
      }
      if (opts.modelsDev) {
        const index = await fetchModelsDev()
        if (index !== undefined) state.devIndex = index
      }
      if (state.models.length === 0) return

      /** @type {Record<string, Record<string, unknown>>} */
      const existing = (() => {
        try {
          const descriptor = settings.describe().find((/** @type {{ ns: string }} */ d) => d.ns === ns)
          const providers = descriptor?.value?.providers
          return providers && typeof providers === 'object' ? providers : {}
        } catch {
          return {}
        }
      })()

      /** @type {Record<string, unknown>} */
      const providerPatch = {}
      const models = state.models.map((m) => buildModel(m, state.devIndex))
      for (const [route, profile] of Object.entries(routes)) {
        if (existing[route] !== undefined) {
          state.installed.add(route)
          // 路由已存在：只替换 models，保留用户对 apiKeyEnv/baseURL 等的修改。
          providerPatch[route] = { models }
        } else if (state.installed.has(route)) {
          if (!state.deleted.has(route)) {
            state.deleted.add(route)
            log.info(`[axonhub] 路由 ${route} 已被删除，插件运行期间不再重建（重启 dsh 后恢复）`)
          }
        } else {
          // 首次安装：写完整 profile。
          providerPatch[route] = { ...profile, apiKeyEnv: credRef, models }
        }
      }
      if (Object.keys(providerPatch).length === 0) return

      const patch = { providers: providerPatch }
      const serialized = JSON.stringify(patch)
      if (serialized === state.lastPatch) return
      await settings.update(ns, patch)
      state.lastPatch = serialized
      for (const route of Object.keys(providerPatch)) state.installed.add(route)
      log.info(`[axonhub] 已同步 ${state.models.length} 个模型到 ${ns}（${Object.keys(providerPatch).join(', ')}）`)
    } catch (err) {
      log.error('[axonhub] 写入 provider 配置失败：', err)
    } finally {
      state.syncing = false
    }
  }

  void sync()

  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer
  ctx.effect(() => {
    if (opts.refreshMs > 0) {
      timer = setInterval(() => {
        void sync()
      }, opts.refreshMs)
    }
    return () => {
      state.disposed = true
      if (timer !== undefined) clearInterval(timer)
    }
  })
}
