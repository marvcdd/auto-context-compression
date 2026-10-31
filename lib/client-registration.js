/**
 * Web 客户端半区的启动注册。
 * Boot registration for the Web client half.
 *
 * DSH 只在 Host 启动时扫描 `dsh.client`；运行中热装 bundle 时，
 * ClientModules 不一定会重新扫描。这里保留两件事：只读诊断，以及
 * 启动时一次性的“补齐注册/刷新 revision”。它依赖 DSH 私有 API，
 * 因此被隔离在这个小模块里，主压缩策略不依赖它。
 * DSH scans `dsh.client` when the Host boots; a hot-installed bundle may not
 * trigger a rescan. This module keeps the read-only diagnostics and a one-shot
 * startup "register/refresh revision" fallback. It uses DSH private APIs on
 * purpose, so it is isolated here and the compression policy never depends on it.
 */

function safeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 创建客户端注册器。
 * Create the client registrar.
 * @param {{
 *   ctx: object,
 *   packageName: string,
 *   clientBundlePath: string,
 *   clientBundleBase: string,
 *   log?: (level: string, message: string) => void,
 * }} options
 */
export function createClientRegistrar({ ctx, packageName, clientBundlePath, clientBundleBase, log = () => {} }) {
  /**
   * 读取 ClientModules 启动图与 loader 行；`forceScan` 只在插件启动时使用。
   * Read the ClientModules boot graph and loader rows; `forceScan` is startup-only.
   * @param {boolean} forceScan
   * @returns {object}
   */
  function diagnostics(forceScan = false) {
    let modules
    try {
      modules = ctx.get('clientModules')
    } catch {
      return { available: false }
    }
    if (modules === undefined || modules === null) return { available: false }
    const result = { available: true }
    let raw
    try {
      raw = ctx.reflect?.get?.('clientModules')
      result.reflect = raw !== undefined
      if (raw !== undefined) {
        result.rawDirty = raw.dirty instanceof Set
        result.rawFlush = typeof raw.flush === 'function'
        result.loaderNames = (raw.ctx?.loader?.entries?.() ?? [])
          .map((entry) => entry.options.name)
          .filter((name) => typeof name === 'string' && name.includes('auto-context'))
        result.loaderCount = raw.ctx?.loader?.entries?.().length ?? 0
        result.loaderSample = (raw.ctx?.loader?.entries?.() ?? [])
          .map((entry) => entry.options.name)
          .slice(0, 12)
      }
    } catch (error) {
      result.reflectError = safeError(error)
    }
    if (forceScan) {
      const errors = []
      const target = raw ?? modules
      const already = (modules.graph?.()?.entries ?? []).some((entry) => entry.id === packageName)
      if (already && raw !== undefined && typeof raw.rebuilt === 'function') {
        try {
          const rev = raw.rebuilt(packageName)
          result.rebuilt = rev ?? null
        } catch (error) {
          result.rebuiltError = safeError(error)
        }
      } else if (!already && raw !== undefined && raw.sources instanceof Map) {
        try {
          const sourceKey = `manual\0${packageName}`
          raw.sources.set(sourceKey, {
            packageName,
            loaderName: packageName,
            baseUrl: clientBundleBase,
            sourceKey,
            meta: {
              clientPath: clientBundlePath.replace(/\\/g, '/'),
              inject: ['@deepseek-ai/dsh-client-ui-conversation'],
              external: [],
              immediately: true,
            },
          })
          raw.reconcilePackage(packageName)
          raw.composed = raw.compose()
          raw.notifyGraphChanged()
          result.injected = true
        } catch (error) {
          result.injectError = safeError(error)
        }
      } else {
        try {
          target.dirty?.add(packageName)
          target.flush?.((error) => errors.push(safeError(error)))
          result.rescan = packageName
        } catch (error) {
          result.rescanError = safeError(error)
        }
      }
      if (errors.length > 0) result.rescanErrors = errors
    }
    try {
      result.loaderEntries = (ctx.loader?.entries?.() ?? [])
        .map((entry) => ({
          id: entry.options.id ?? null,
          name: entry.options.name ?? null,
          disabled: entry.disabled === true,
          hasFiber: entry.fiber !== undefined,
        }))
        .filter((entry) => typeof entry.name === 'string' && entry.name.includes('auto-context'))
    } catch (error) {
      result.loaderError = safeError(error)
    }
    try {
      const graph = modules.graph()
      result.rev = graph?.rev ?? null
      result.entries = (graph?.entries ?? []).map((entry) => ({
        id: entry.id,
        url: entry.url,
        immediately: entry.immediately === true,
        external: entry.external === true,
      }))
      result.batches = (graph?.batches ?? []).map((batch) => ({
        phase: batch.phase,
        url: batch.url,
        entries: (batch.entries ?? []).map((entry) => entry.id),
      }))
    } catch (error) {
      result.graphError = safeError(error)
    }
    try {
      result.clientPath = modules.clientPath(packageName) ?? null
    } catch (error) {
      result.pathError = safeError(error)
    }
    return result
  }

  /** Host 错过启动扫描时，在运行时注册或刷新客户端半区。Register or refresh the client half when the Host missed the boot scan. */
  function ensure() {
    try {
      const after = diagnostics(true)
      if (after.injected === true) log('info', 'client bundle registered at runtime')
      if (after.rebuilt !== undefined && after.rebuilt !== null) {
        log('debug', `client bundle revision refreshed: ${after.rebuilt}`)
      }
    } catch (error) {
      log('debug', `client registration skipped: ${safeError(error)}`)
    }
  }

  return { diagnostics, ensure }
}
