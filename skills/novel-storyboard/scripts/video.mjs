// video.mjs —— 用本机 ComfyUI 的视频 workflow，把 export 出的 H3 投产包逐段跑成视频。零依赖，node >= 18。
//
// workflow 是你在 ComfyUI 里导出的 API 格式 JSON（菜单 Export (API)）。把每段要换的输入值写成占位符：
//   {{prompt}}             这一段的 H3 提示词（prompt.md 分隔线以下）
//   {{image1}}…{{imageN}}  这一段的分镜图 f1..fN.png（先上传到 ComfyUI，再填上传后的文件名）
//   {{seconds}} {{cuts}}   这一段的秒数、分镜数（manifest.json）
//   {{seed}}               随机种子（--seed 固定）
//   {{segment}}            段号，例如 E01-01，可以拿来当输出文件名前缀
// 一个输入值整个就是一个占位符、换上去是数字（秒数、分镜数、种子）时按数字填，其余按字符串替换。
//
// 整批只向本机 Strata 借一次 GPU（gpu-lease.mjs）；每段跑完写一次 video-state.json，断了再跑从断点接着来。

import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaseCommand, leaseSettings, parseEnvText, withLease } from './gpu-lease.mjs';

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 本机配置：ComfyUI 地址与租约设置。放在 skill 目录，文件名带 .local，不进版本控制。环境变量只给自测用。 */
export const CONFIG_PATH = process.env.NOVEL_STORYBOARD_CONFIG || join(SKILL_DIR, 'config.local.json');
export const STATE_FILE = 'video-state.json';
const NUMERIC = new Set(['seconds', 'cuts', 'seed']);
const KNOWN = /^(prompt|seconds|cuts|seed|segment|image[1-9]\d*)$/;

export function loadConfig(path = CONFIG_PATH) {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { comfy: { url: null, envFile: null, ...(raw.comfy ?? {}) }, strataLease: raw.strataLease ?? null, video: { timeoutS: 3600, pollS: 3, ...(raw.video ?? {}) } };
}
export const saveConfig = (cfg, path = CONFIG_PATH) => writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

/** ComfyUI 地址与 Basic 鉴权：配置里的 url，或 COMFY_URL / COMFY_USER / COMFY_PASS（环境变量优先，再查 envFile）。 */
export function comfyEndpoint(c, env = process.env) {
  const file = c.envFile ? parseEnvText(readFileSync(resolve(String(c.envFile).replace(/^~/, homedir())), 'utf8')) : {};
  const pick = (k) => env[k] || file[k] || '';
  const url = String(c.url || pick('COMFY_URL')).replace(/\/+$/, '');
  if (!url) throw new Error('ComfyUI 没配地址：运行 config --comfy-url http://127.0.0.1:8188，或设 COMFY_URL');
  const user = pick('COMFY_USER'), pass = pick('COMFY_PASS');
  return { url, auth: user ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null };
}

/** prompt.md 分隔线以下就是 h3Prompt 原样（exportPack 写的格式）。 */
export function h3FromPromptMd(md) {
  const i = md.indexOf('\n---\n\n');
  if (i < 0) throw new Error('prompt.md 里没有分隔线 ---（不是 export 生成的？）');
  return md.slice(i + 6).replace(/\n$/, '');
}

/** workflow 里用到的占位符名（去重、按出现顺序）。 */
export function placeholdersOf(workflow) {
  const out = new Set();
  JSON.stringify(workflow).replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k) => { out.add(k); return _; });
  return [...out];
}

/** 把占位符换成这一段的值。workflow 用到但 vars 没有的占位符：报错（这一段跑不了）。 */
export function fillWorkflow(workflow, vars) {
  const unknown = placeholdersOf(workflow).filter((k) => !KNOWN.test(k));
  if (unknown.length) throw new Error(`workflow 里有不认识的占位符：${unknown.map((k) => `{{${k}}}`).join('、')}`);
  const missing = placeholdersOf(workflow).filter((k) => !(k in vars));
  if (missing.length) throw new Error(`这一段提供不了 ${missing.map((k) => `{{${k}}}`).join('、')}（分镜图不够？）`);
  const walk = (x) => {
    if (typeof x === 'string') {
      const whole = x.match(/^\{\{\s*([\w-]+)\s*\}\}$/);
      if (whole) return NUMERIC.has(whole[1]) ? Number(vars[whole[1]]) : String(vars[whole[1]]);
      return x.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k) => String(vars[k]));
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return walk(workflow);
}

/** 投产包里这次要跑的段：跳过已完成的（除非 force）、缺图的；segments 只跑点名的。 */
export function planSegments(packDir, manifest, state, { only = null, force = false } = {}) {
  const run = [], skipped = [];
  for (const m of manifest) {
    if (only && !only.includes(m.segment)) continue;
    const pics = (m.pictures ?? []).map((p) => join(packDir, m.segment, basename(p)));
    const absent = pics.filter((p) => !existsSync(p));
    if (absent.length) { skipped.push({ segment: m.segment, why: `缺分镜图 ${absent.map((p) => basename(p)).join('、')}` }); continue; }
    if (!existsSync(join(packDir, m.segment, 'prompt.md'))) { skipped.push({ segment: m.segment, why: '缺 prompt.md' }); continue; }
    const prev = state.segments?.[m.segment];
    if (!force && prev?.status === 'done' && (prev.files ?? []).every((f) => existsSync(join(packDir, m.segment, f)))) {
      skipped.push({ segment: m.segment, why: '已完成' });
      continue;
    }
    run.push({ ...m, pics });
  }
  if (only) for (const s of only) if (!manifest.some((m) => m.segment === s)) skipped.push({ segment: s, why: 'manifest 里没有这一段' });
  return { run, skipped };
}

export function readState(packDir) {
  const p = join(packDir, STATE_FILE);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { segments: {} };
}
function writeState(packDir, state) {
  state.updatedAt = new Date().toISOString();
  writeFileSync(join(packDir, STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function http(ep, method, path, body, { timeoutMs = 120_000, raw = false } = {}) {
  const headers = { ...(ep.auth ? { Authorization: ep.auth } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(ep.url + path, { method, headers, body: body && !(body instanceof FormData) ? JSON.stringify(body) : body, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`ComfyUI ${path.split('?')[0]} 返回 HTTP ${r.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
  }
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}

/** history 的 outputs 里所有带 filename 的文件（图片、视频、gif……），按节点顺序。 */
export function outputFiles(outputs) {
  const files = [];
  for (const node of Object.values(outputs ?? {})) {
    for (const list of Object.values(node ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const f of list) if (f && typeof f === 'object' && typeof f.filename === 'string') files.push(f);
    }
  }
  return files;
}

/** 跑一段：上传分镜图 → /prompt → 轮询 /history → 下载输出到段文件夹。 -> 保存的文件名列表 */
async function runSegment(ep, packDir, seg, workflow, { seed, timeoutS, pollS, sleep }) {
  const vars = { prompt: h3FromPromptMd(readFileSync(join(packDir, seg.segment, 'prompt.md'), 'utf8')), seconds: seg.seconds, cuts: seg.cuts ?? seg.pics.length,
    seed: seed ?? Math.floor(Math.random() * 2 ** 31), segment: seg.segment };
  const wanted = placeholdersOf(workflow).filter((k) => /^image\d+$/.test(k)).map((k) => Number(k.slice(5)));
  for (const k of wanted) {
    const pic = seg.pics[k - 1];
    if (!pic) continue;                                      // fillWorkflow 会报“提供不了”
    const form = new FormData();
    form.append('image', new Blob([readFileSync(pic)], { type: 'image/png' }), `${seg.segment}-${basename(pic)}`);
    form.append('subfolder', 'novel-storyboard');
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const up = await http(ep, 'POST', '/upload/image', form);
    vars[`image${k}`] = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
  }
  const wf = fillWorkflow(workflow, vars);
  const res = await http(ep, 'POST', '/prompt', { prompt: wf, client_id: `novel-storyboard-${process.pid}` });
  if (res.node_errors && Object.keys(res.node_errors).length) throw new Error(`workflow 有节点报错：${JSON.stringify(res.node_errors).slice(0, 300)}`);
  const pid = res.prompt_id;
  const t0 = Date.now();
  for (;;) {
    const h = await http(ep, 'GET', `/history/${pid}`);
    const item = h[pid];
    if (item) {
      const st = item.status ?? {};
      if (st.status_str === 'error') {
        const m = (st.messages ?? []).find((x) => x[0] === 'execution_error');
        throw new Error(`ComfyUI 执行出错：${m?.[1]?.exception_message ?? '未知错误'}`);
      }
      if (st.completed !== false) {
        const files = outputFiles(item.outputs);
        if (!files.length) throw new Error('ComfyUI 跑完了，但没有输出文件（workflow 里有保存节点吗？）');
        const saved = [];
        for (const [i, f] of files.entries()) {
          const ext = extname(f.filename) || '.bin';
          const name = files.length === 1 ? `${seg.segment}${ext}` : `${seg.segment}-${i + 1}${ext}`;
          const buf = await http(ep, 'GET', `/view?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' })}`, null, { raw: true, timeoutMs: 600_000 });
          writeFileSync(join(packDir, seg.segment, name), buf);
          saved.push(name);
        }
        return { files: saved, seed: vars.seed };
      }
    }
    if (Date.now() - t0 > timeoutS * 1000) {
      await http(ep, 'POST', '/interrupt', {}).catch(() => {});
      throw new Error(`等了 ${timeoutS} 秒还没出视频，已中断这一段`);
    }
    await sleep(pollS * 1000);
  }
}

/** video 命令本体。返回 { done, failed, skipped }。 */
export async function runVideo(packDir, workflowPath, { only = null, force = false, seed = null, cfg = loadConfig(), log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  packDir = resolve(packDir);
  const manifestPath = join(packDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${packDir} 里没有 manifest.json——先用 export（H3 协议）导出投产包`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const workflow = JSON.parse(readFileSync(resolve(workflowPath), 'utf8'));
  const names = placeholdersOf(workflow);
  const unknown = names.filter((k) => !KNOWN.test(k));
  if (unknown.length) throw new Error(`workflow 里有不认识的占位符：${unknown.map((k) => `{{${k}}}`).join('、')}`);
  if (!names.includes('prompt')) log('△ workflow 里没有 {{prompt}}：每段都会用 workflow 里写死的提示词');
  const ep = comfyEndpoint(cfg.comfy);
  const state = readState(packDir);
  const { run, skipped } = planSegments(packDir, manifest, state, { only, force });
  for (const s of skipped) log(`- ${s.segment}：跳过（${s.why}）`);
  if (!run.length) { log('没有要跑的段'); return { done: 0, failed: 0, skipped: skipped.length }; }
  state.workflow = resolve(workflowPath);
  state.segments ??= {};
  state.running = { pid: process.pid, since: new Date().toISOString(), segments: run.map((s) => s.segment) };
  writeState(packDir, state);
  let done = 0, failed = 0;
  try {
    await withLease(leaseSettings(cfg.strataLease), ep, async () => {
      for (const seg of run) {
        const t0 = Date.now();
        state.segments[seg.segment] = { status: 'running', at: new Date().toISOString() };
        writeState(packDir, state);
        try {
          const r = await runSegment(ep, packDir, seg, workflow, { seed, timeoutS: cfg.video.timeoutS, pollS: cfg.video.pollS, sleep });
          state.segments[seg.segment] = { status: 'done', files: r.files, seed: r.seed, seconds: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() };
          done++;
          log(`✓ ${seg.segment}  ${r.files.join(', ')}  ${state.segments[seg.segment].seconds}s`);
        } catch (e) {
          state.segments[seg.segment] = { status: 'failed', error: e.message, seconds: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() };
          failed++;
          log(`✗ ${seg.segment}：${e.message}`);
        }
        writeState(packDir, state);
      }
    }, { log, holder: 'novel-storyboard' });
  } finally {
    delete state.running;
    for (const s of run) if (state.segments[s.segment]?.status === 'running') state.segments[s.segment] = { status: 'failed', error: '中途停止', at: new Date().toISOString() };
    writeState(packDir, state);
  }
  log(`${failed ? '△' : '✓'} ${done} 段完成${failed ? `，${failed} 段失败（再运行同一条命令只重跑失败和没跑的）` : ''}${skipped.length ? `，${skipped.length} 段跳过` : ''}`);
  return { done, failed, skipped: skipped.length };
}

/** video-status：状态文件的摘要。 */
export function videoStatus(packDir) {
  const state = readState(resolve(packDir));
  const rows = Object.entries(state.segments ?? {}).map(([seg, s]) => `${s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '…'} ${seg}  ${s.status}${s.files ? `  ${s.files.join(', ')}` : ''}${s.error ? `  ${s.error}` : ''}`);
  let alive = false;
  if (state.running?.pid) { try { process.kill(state.running.pid, 0); alive = true; } catch { alive = false; } }
  const head = state.running ? (alive ? `运行中（pid ${state.running.pid}，开始于 ${state.running.since}）` : `上次运行在 pid ${state.running.pid} 中途停了（再运行 video 从断点继续）`) : '没有在运行';
  return { text: [head, ...rows].join('\n'), running: alive, state };
}

/** --detach：同一条命令换成后台进程跑，输出写进投产包的 video.log。 */
export function detach(argv, packDir) {
  const log = join(resolve(packDir), 'video.log');
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  const script = fileURLToPath(new URL('./novel-storyboard.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, ...argv.filter((a) => a !== '--detach')], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  return { pid: child.pid, log };
}

const flagOf = (rest, name, fallback = null) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : fallback;
};

/** novel-storyboard.mjs 的 video / video-status / config / lease 命令（异步）。 */
export async function videoMain(cmd, rest) {
  if (cmd === 'config') {
    const cfg = loadConfig();
    const cu = flagOf(rest, '--comfy-url'); if (cu) cfg.comfy.url = cu;
    const ce = flagOf(rest, '--comfy-env-file'); if (ce) cfg.comfy.envFile = resolve(ce);
    const to = flagOf(rest, '--timeout'); if (to) { if (!(Number(to) > 0)) throw new Error('--timeout 要一个秒数'); cfg.video.timeoutS = Number(to); }
    const sl = flagOf(rest, '--strata-lease'), su = flagOf(rest, '--strata-url'), se = flagOf(rest, '--strata-env-file'), sv = flagOf(rest, '--strata-min-free-vram');
    if (sl || su || se || sv) {
      const lease = { ...(cfg.strataLease ?? {}) };
      if (sl) { if (!['on', 'off'].includes(sl)) throw new Error('--strata-lease 只能是 on / off'); lease.enabled = sl === 'on'; }
      if (su) lease.url = su;
      if (se) lease.envFile = resolve(se);
      if (sv) { if (!(Number(sv) >= 0)) throw new Error('--strata-min-free-vram 要一个 MiB 数'); lease.minFreeVramMib = Number(sv); }
      cfg.strataLease = lease;
    }
    if (rest.some((a) => a.startsWith('--') && a !== '--show')) saveConfig(cfg);
    console.log(JSON.stringify(cfg, null, 2));
    console.log(`\n配置文件：${CONFIG_PATH}`);
    return 0;
  }
  if (cmd === 'lease') {
    const cfg = loadConfig();
    let comfy = null;
    try { comfy = comfyEndpoint(cfg.comfy); } catch { comfy = null; }
    console.log(JSON.stringify(await leaseCommand(rest, { ...leaseSettings(cfg.strataLease), holder: 'manual' }, comfy), null, 2));
    return 0;
  }
  if (cmd === 'video-status') {
    const [pack] = rest.filter((a) => !a.startsWith('--'));
    if (!pack) throw new Error('用法：video-status <投产包目录>');
    console.log(videoStatus(pack).text);
    return 0;
  }
  // video
  const pack = rest.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--workflow', '--segments', '--seed'].includes(rest[i - 1])));
  const wf = flagOf(rest, '--workflow');
  if (!pack || !wf) throw new Error('用法：video <投产包目录> --workflow <API 格式的 workflow.json> [--segments E01-01,E01-02] [--force] [--seed n] [--detach]');
  if (rest.includes('--detach')) {
    const st = videoStatus(pack);
    if (st.running) throw new Error(`这个投产包已经有一个 video 在跑（pid ${st.state.running.pid}），用 video-status 看进度`);
    const d = detach(['video', ...rest], pack);
    console.log(`✓ 已在后台运行（pid ${d.pid}），输出写在 ${d.log}\n  本地大模型会在整批跑完后才恢复；用 video-status ${pack} 看进度`);
    return 0;
  }
  const seed = flagOf(rest, '--seed');
  const seg = flagOf(rest, '--segments');
  const r = await runVideo(pack, wf, { only: seg ? seg.split(',').map((s) => s.trim()).filter(Boolean) : null, force: rest.includes('--force'), seed: seed === null ? null : Number(seed) });
  return r.failed ? 1 : 0;
}
