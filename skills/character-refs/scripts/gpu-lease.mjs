// gpu-lease.mjs —— 出图、出视频前向本机 Strata 借 GPU（租约），用完还回去。零依赖，node >= 18。
//
// 本地大模型（Strata）平时把显存和内存都占满；同一台机器上的 ComfyUI 要用 GPU 时：
//   申请租约（Strata 存好对话、卸载模型）→ 跑 ComfyUI → 让 ComfyUI 释放显存（/free）→ 等显存真正空出来 → 归还租约
//   （Strata 重新加载、恢复对话）。租约期间每隔 ttl/3 续期一次；进程被杀没来得及归还时，Strata 在 TTL 到期后自己收回。
// 接口说明：Strata 仓库的 docs/GPU_LEASE.md。
//
// 这个文件在 character-refs 和 novel-storyboard 里各有一份，内容必须完全相同（skill 要能单独拷走，不能互相 import）。
// 改一份就同步另一份；仓库根目录的 scripts/check-shared.mjs 会比对。
//
// 凭据只从环境变量或配置里指定的 .env 文件读（STRATA_LEASE_KEY、STRATA_API_KEY），从不打印。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { freemem, homedir } from 'node:os';
import { resolve } from 'node:path';

export const LEASE_DEFAULTS = {
  enabled: false,             // 不开：出图流程和以前完全一样，不碰 Strata
  url: 'http://127.0.0.1:8080',
  envFile: null,              // 可选：从这个 .env 读 STRATA_LEASE_KEY / STRATA_API_KEY（和 Strata 的 gpu_lease_key_file 可以是同一个文件）
  policy: 'unload',           // unload：Strata 卸载模型，显存和内存都让出；shrink：只让出显存（需要 Strata 开 vram_elastic）
  reserveMib: null,           // shrink 时要空出多少 MiB 显存
  ttlS: 600,                  // 每次续期的时长；进程被杀后最多这么久 Strata 就会收回
  waitS: 900,                 // 申请时最多等多久（等 Strata 手头的请求答完）
  reload: 'eager',            // 归还后 Strata 立刻重新加载（eager），还是等下一个请求（lazy）
  holder: null,               // 显示在 Strata 日志里的名字；不给就用 skill 名
  freeComfy: true,            // 归还前让 ComfyUI 卸载模型、释放内存（POST /free）
  minFreeVramMib: 0,          // 归还前等空闲显存至少这么多（0 = 不等）；建议和 Strata 的 min_free_vram_mib 一致
  minFreeRamMib: 0,           // 归还前等可用内存至少这么多（0 = 不等）
  resourceWaitS: 120,         // 上面两项最多等多久，等不到只警告、照样归还
};

export const MANUAL_TTL_S = 3600;   // 手动 lease acquire 没人自动续期，默认给长一点

export class LeaseError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 配置里的 strataLease 段，补上默认值。 */
export function leaseSettings(raw) {
  return { ...LEASE_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

/** KEY=VALUE 一行一个，# 开头是注释，值两端的一个引号去掉（与 Strata 服务端 serve/gpu_lease.py 的 parse_env 一致）。 */
export function parseEnvText(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

/** 地址和请求头：先查环境变量，再查 envFile。key 不进返回值以外的任何地方。 */
export function leaseEndpoint(ls, env = process.env) {
  const file = ls.envFile ? parseEnvText(readFileSync(resolve(String(ls.envFile).replace(/^~/, homedir())), 'utf8')) : {};
  const pick = (k) => String(env[k] || file[k] || '').trim();
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = pick('STRATA_API_KEY');
  const leaseKey = pick('STRATA_LEASE_KEY');
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (leaseKey) headers['X-Strata-Lease-Key'] = leaseKey;
  return { url: String(env.STRATA_URL || ls.url || LEASE_DEFAULTS.url).replace(/\/+$/, ''), headers };
}

async function call(ep, method, path, body, timeoutMs) {
  let r;
  try {
    r = await fetch(ep.url + path, {
      method, headers: ep.headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new LeaseError(`连不上 Strata（${ep.url}）：${e.cause?.code ?? e.name ?? e.message}`, { code: 'unreachable' });
  }
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const err = json?.error ?? {};
    throw new LeaseError(`Strata 返回 ${r.status}${err.code ? ` ${err.code}` : ''}：${err.message ?? '未知错误'}`,
      { status: r.status, code: err.code ?? '' });
  }
  return json ?? {};
}

/** 申请：等 Strata 腾出 GPU 后返回 { lease_id, policy, conversation_saved, ... }。等待时间可能很长（保存长对话、卸载模型）。 */
export async function acquire(ls, { holder, ttlS, env } = {}) {
  const ep = leaseEndpoint(ls, env);
  const body = { holder: holder || ls.holder || 'shuohao-skills', policy: ls.policy, ttl_s: ttlS ?? ls.ttlS, wait_s: ls.waitS, reload: ls.reload };
  if (ls.reserveMib !== null && ls.reserveMib !== undefined) body.reserve_mib = ls.reserveMib;
  return call(ep, 'POST', '/v1/gpu/lease', body, (ls.waitS + 1800) * 1000);
}

export const renew = (ls, id, ttlS, env) => call(leaseEndpoint(ls, env), 'POST', `/v1/gpu/lease/${encodeURIComponent(id)}/renew`, { ttl_s: ttlS ?? ls.ttlS }, 30_000);
export const release = (ls, id, reload, env) => call(leaseEndpoint(ls, env), 'POST', `/v1/gpu/lease/${encodeURIComponent(id)}/release`, reload ? { reload } : {}, 30_000);
export const leaseStatus = (ls, env) => call(leaseEndpoint(ls, env), 'GET', '/v1/gpu/lease', undefined, 30_000);

/** ComfyUI 卸载模型、释放内存。comfy = { url, auth }（auth 是完整的 Authorization 值或 null）。失败只返回原因，不抛。 */
export async function comfyFree(comfy) {
  if (!comfy?.url) return 'no ComfyUI address';
  try {
    const r = await fetch(comfy.url.replace(/\/+$/, '') + '/free', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(comfy.auth ? { Authorization: comfy.auth } : {}) },
      body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(30_000),
    });
    return r.ok ? null : `HTTP ${r.status}`;
  } catch (e) {
    return e.cause?.code ?? e.message;
  }
}

/** nvidia-smi 读第一张卡的空闲显存（MiB）；读不到返回 null。 */
export function freeVramMib(run = spawnSync) {
  try {
    const r = run('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 10_000 });
    const n = parseInt(String(r.stdout ?? '').trim().split(/\r?\n/)[0], 10);
    return r.status === 0 && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export const freeRamMib = () => Math.floor(freemem() / 2 ** 20);

/** 等显存和内存空出来（ComfyUI 的 /free 是异步执行的）。读不到的一项不等。 -> { ok, vram, ram, waitedS } */
export async function waitResources(ls, { vram = freeVramMib, ram = freeRamMib, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const t0 = now();
  const needV = Number(ls.minFreeVramMib) || 0, needR = Number(ls.minFreeRamMib) || 0;
  for (;;) {
    const v = needV ? vram() : null, m = needR ? ram() : null;
    const done = (v === null || v >= needV) && (m === null || m >= needR);
    if (done || now() - t0 >= (Number(ls.resourceWaitS) || 0) * 1000) return { ok: done, vram: v, ram: m, waitedS: Math.round((now() - t0) / 100) / 10 };
    await sleep(1000);
  }
}

/**
 * 在租约里执行 fn(lease)。没开（enabled 不是 true）就直接执行 fn(null)，一切照旧。
 * 申请失败抛 LeaseError，fn 不会执行。fn 抛错、正常结束、Ctrl+C 都会：让 ComfyUI 释放 → 等资源 → 归还。
 */
export async function withLease(ls, comfy, fn, { log = console.log, holder, env, deps = {} } = {}) {
  if (ls?.enabled !== true) return fn(null);
  const api = { acquire, renew, release, comfyFree, waitResources, ...deps };
  log(`… 向 Strata 借 GPU（${ls.policy}）：本地大模型会暂停，等它存好对话、让出显存`);
  const lease = await api.acquire(ls, { holder, env });
  const id = lease.lease_id;
  log(`✓ 已借到 GPU（${lease.policy}${lease.conversation_saved ? `，对话 ${lease.conversation_saved.tokens} tokens 已保存` : ''}）`);
  let lost = false, done = false;
  const tick = setInterval(() => {
    api.renew(ls, id, undefined, env).catch((e) => {
      if (!lost) log(`△ 续期失败：${e.message}${e.status === 404 ? '（租约已被 Strata 收回，本地大模型可能已经开始重新加载）' : ''}`);
      if (e.status === 404) lost = true;
    });
  }, Math.max(1000, (Number(ls.ttlS) * 1000) / 3));
  tick.unref?.();
  const giveBack = async () => {
    if (done) return;
    done = true;
    clearInterval(tick);
    if (ls.freeComfy !== false && comfy) {
      const why = await api.comfyFree(comfy);
      if (why) log(`△ ComfyUI 没有释放显存（${why}）`);
    }
    const w = await api.waitResources(ls);
    if (!w.ok) log(`△ 等了 ${w.waitedS} 秒，显存/内存还没空到设定值（显存 ${w.vram ?? '?'} MiB，内存 ${w.ram ?? '?'} MiB），照样归还`);
    if (lost) return;
    try {
      const r = await api.release(ls, id, undefined, env);
      log(`✓ 已把 GPU 还给 Strata${r.reload === 'started' ? '，本地大模型重新加载中' : r.reload === 'lazy' ? '，下一个请求时重新加载' : ''}`);
    } catch (e) {
      log(`△ 归还失败：${e.message}。Strata 会在租约到期后自己收回；也可以手动运行 lease release ${id}`);
    }
  };
  const onSignal = (sig) => {
    giveBack().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await fn(lease);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await giveBack();
  }
}

/** 手动的 lease 子命令：acquire [--ttl N] | renew <id> [--ttl N] | release <id> | status。返回要打印的对象。 */
export async function leaseCommand(args, ls, comfy, { env, deps = {} } = {}) {
  const api = { acquire, renew, release, leaseStatus, comfyFree, waitResources, ...deps };
  const [sub, id] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--ttl'));
  const ti = args.indexOf('--ttl');
  const ttl = ti >= 0 ? Number(args[ti + 1]) : null;
  if (ti >= 0 && !(ttl > 0)) throw new LeaseError('--ttl 要一个秒数');
  if (!['status', 'acquire', 'renew', 'release'].includes(sub)) throw new LeaseError(`不认识的 lease 子命令 ${sub ?? '（空）'}（acquire / renew / release / status）`);
  if (sub === 'status') return api.leaseStatus(ls, env);
  if (sub === 'acquire') return api.acquire({ ...ls, ttlS: ttl ?? MANUAL_TTL_S }, { holder: ls.holder || 'manual', env });
  if (!id) throw new LeaseError(`用法：lease ${sub} <lease_id>`);
  if (sub === 'renew') return api.renew(ls, id, ttl ?? MANUAL_TTL_S, env);
  const why = ls.freeComfy !== false && comfy ? await api.comfyFree(comfy) : null;
  const w = await api.waitResources(ls);
  const out = await api.release(ls, id, undefined, env);
  return { ...out, comfy_free: why ?? 'ok', resources: w };
}
