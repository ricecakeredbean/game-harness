#!/usr/bin/env node
// Rojo 프로젝트 검사: rojo sourcemap → luau-lsp analyze → selene → stylua --check.
// 사용법은 README.md 참고. 종료 코드: 0=통과 1=검사 실패 2=검사 불가(차단·도구 없음 포함)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

// main 프로젝트 폴더: ROBLOX_CHECK_MAIN → 인자로 준 경로(없으면 현재 폴더)가 속한 git 저장소의 main worktree
function findMain() {
  if (process.env.ROBLOX_CHECK_MAIN) return path.resolve(process.env.ROBLOX_CHECK_MAIN);
  const p = process.argv.slice(2).find((a) => !a.startsWith('--') && fs.existsSync(a));
  const r = cp.spawnSync('git', ['-C', p || process.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const common = (r.stdout || '').trim();
  if (r.status === 0 && path.basename(common) === '.git') return path.dirname(path.resolve(common));
  console.error('main 프로젝트를 찾지 못함 — 프로젝트(또는 그 worktree) 폴더에서 실행하거나 ROBLOX_CHECK_MAIN 환경변수로 지정');
  process.exit(2);
}
const MAIN = findMain();
const WT_ROOT = MAIN + '-wt';
const MAX_ERRORS = 20;
const TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const ROKIT_BIN = path.join(os.homedir(), '.rokit', 'bin');
const ENV = { ...process.env, PATH: ROKIT_BIN + path.delimiter + (process.env.PATH || process.env.Path || '') };

const posix = (p) => p.replace(/\\/g, '/');
const lc = (p) => posix(p).toLowerCase();

function git(cwd, args, opt = {}) {
  const r = cp.spawnSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opt });
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() };
}

// 비교 기준 브랜치: ROBLOX_CHECK_BASE → main → master → main 폴더의 현재 브랜치
function baseBranch() {
  if (process.env.ROBLOX_CHECK_BASE) return process.env.ROBLOX_CHECK_BASE;
  for (const b of ['main', 'master']) if (git(MAIN, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]).ok) return b;
  return git(MAIN, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || 'main';
}

class Stop extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// ---------- 보조 명령: new / remove ----------
function cmdNew(name, noGate) {
  if (!name) throw new Stop(2, '사용법: node check.js new <이름> [--no-gate]');
  const dir = path.join(WT_ROOT, name);
  const r = git(MAIN, ['worktree', 'add', '-b', `feature/${name}`, dir, 'HEAD']);
  if (!r.ok) throw new Stop(2, `worktree 생성 실패: ${r.err}`);
  console.log(`생성: ${posix(dir)} (브랜치 feature/${name})`);
  if (!noGate) installGate(dir);
}

// worktree 에만 Stop 훅(gate.js) 설치. git 제외는 공용 .git/info/exclude
function installGate(dir) {
  const gate = posix(path.join(__dirname, 'gate.js'));
  // 워커가 승인 없이 검사를 직접 돌릴 수 있게 check.js 실행만 허용
  const check = posix(path.join(__dirname, 'check.js'));
  const allow = [`node ${check} *`, `node "${check}" *`].flatMap(c => [`Bash(${c})`, `PowerShell(${c})`]);
  const settings = {
    permissions: { allow },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${gate}"`, timeout: 900 }] }] },
  };
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(settings, null, 2) + '\n');
  const common = git(MAIN, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) throw new Stop(2, `git 공용 폴더 확인 실패: ${common.err}`);
  const ex = path.join(common.out.trim(), 'info', 'exclude');
  const line = '.claude/settings.local.json';
  const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes(line)) {
    fs.mkdirSync(path.dirname(ex), { recursive: true });
    fs.appendFileSync(ex, (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n');
  }
  console.log(`게이트 설치: ${posix(path.join(dir, '.claude', 'settings.local.json'))}`);
}

function cmdRemove(name, force) {
  if (!name) throw new Stop(2, '사용법: node check.js remove <이름> [--force]');
  const dir = path.join(WT_ROOT, name);
  const r = git(MAIN, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  if (!r.ok) throw new Stop(2, `worktree 삭제 실패: ${r.err} (변경이 있으면 --force)`);
  const b = git(MAIN, ['branch', force ? '-D' : '-d', `feature/${name}`]);
  if (!b.ok) console.log(`브랜치 유지: ${b.err} (병합 전이면 --force 로 강제 삭제)`);
  fs.rmSync(workDirFor(dir), { recursive: true, force: true });
  console.log(`삭제: ${posix(dir)}${b.ok ? ` + 브랜치 feature/${name}` : ''}`);
}

// worktree 별 임시 작업 폴더 (sourcemap·result.json)
function workDirFor(wt) {
  const h = crypto.createHash('sha1').update(lc(wt)).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), 'roblox-check', `${path.basename(wt)}-${h}`);
}

// ---------- 변경 목록 (브랜치 diff + 작업 트리) ----------
function collectTouched(wt) {
  const touched = new Set();
  const d = git(wt, ['diff', '--no-renames', '--name-only', '-z', `${baseBranch()}...HEAD`]);
  if (!d.ok) throw new Stop(2, `git diff ${baseBranch()}...HEAD 실패: ${d.err}`);
  for (const p of d.out.split('\0')) if (p) touched.add(p);
  const s = git(wt, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames']);
  if (!s.ok) throw new Stop(2, `git status 실패: ${s.err}`);
  for (const e of s.out.split('\0')) if (e.length >= 4) touched.add(e.slice(3));
  return touched;
}

// ---------- 도구 실행·출력 파싱 ----------
function run(tool, args, cwd) {
  const exe = path.join(ROKIT_BIN, tool + '.exe');
  const r = cp.spawnSync(fs.existsSync(exe) ? exe : tool, args,
    { cwd, env: ENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: TOOL_TIMEOUT_MS });
  if (r.error) throw new Stop(2, `${tool} 실행 실패: ${r.error.code === 'ENOENT' ? '도구 없음 (rokit install)' : r.error.message}`);
  return { status: r.status, text: (r.stdout || '') + '\n' + (r.stderr || '') };
}

function relFrom(wt, f) {
  const p = posix(f.trim());
  const w = lc(wt) + '/';
  return p.toLowerCase().startsWith(w) ? p.slice(w.length) : p;
}
const clip = (s) => (s.length > 300 ? s.slice(0, 300) + '…' : s);
const tailMsg = (text) => text.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300);

// luau-lsp: `경로 [game/…](줄,열): TypeError: 메시지` / `경로(줄,열): LocalUnused: 메시지`
function parseLsp(text, wt) {
  const re = /^(.+?)(?: \[[^\]]*\])?\((\d+),(\d+)\): (\w+): (.*)$/;
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line.trimEnd());
    if (!m) continue;
    const isErr = /Error$/.test(m[4]);
    items.push({ tool: 'luau-lsp', severity: isErr ? 'error' : 'warning', file: relFrom(wt, m[1]), line: +m[2], kind: m[4], msg: clip(m[5]) });
  }
  return items;
}
// selene --display-style=quiet: `경로:줄:열: error[규칙]: 메시지`
function parseSelene(text, wt) {
  const re = /^(.+?):(\d+):(\d+): (error|warning)\[([^\]]+)\]: (.*)$/;
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line.trimEnd());
    if (m) items.push({ tool: 'selene', severity: m[4], file: relFrom(wt, m[1]), line: +m[2], kind: m[5], msg: clip(m[6]) });
  }
  return items;
}
// stylua --check: `Diff in 경로:` 다음 diff 에서 처음 바뀐 줄
function parseStylua(text, wt) {
  const items = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^Diff in (.+?):\s*$/.exec(line);
    if (h) {
      cur = { tool: 'stylua', severity: 'error', file: relFrom(wt, h[1]), line: 0, kind: 'format', msg: '서식이 stylua 와 다름 (stylua src 로 정리)' };
      items.push(cur);
      continue;
    }
    if (cur && !cur.line) {
      const d = /^\s*(\d+)?\s+(\d+)?\s*\|[-+]/.exec(line);
      if (d) cur.line = +(d[1] || d[2]);
    }
  }
  return items;
}

// ---------- 검사 ----------
function runCheck(arg) {
  const t0 = Date.now();
  const notes = [];
  const wt = path.resolve(fs.existsSync(arg) ? arg : path.join(WT_ROOT, arg));
  if (!fs.existsSync(path.join(wt, 'default.project.json'))) throw new Stop(2, `Rojo 프로젝트가 아님 (default.project.json 없음): ${posix(wt)}`);
  const isMain = lc(wt) === lc(MAIN);

  // 차단: 프로젝트 설정·툴체인·플레이스 파일 변경 (브랜치에서만)
  if (!isMain) {
    const blocked = [...collectTouched(wt)].filter((p) => p === 'default.project.json' || p === 'rokit.toml' || /\.rbxlx?$/.test(p));
    if (blocked.length) throw new Stop(2, `프로젝트 설정 변경은 main 에서 하세요 (브랜치에서 변경됨: ${blocked.join(', ')})`);
  }

  const work = workDirFor(wt);
  fs.mkdirSync(work, { recursive: true });
  const sm = path.join(work, 'sourcemap.json');
  const rj = run('rojo', ['sourcemap', 'default.project.json', '-o', sm], wt);
  if (rj.status !== 0) throw new Stop(2, `rojo sourcemap 실패: ${tailMsg(rj.text)}`);

  const lsp = run('luau-lsp', ['analyze', `--sourcemap=${sm}`, '--definitions=@roblox=tools/types/globalTypes.d.luau', 'src'], wt);
  const sel = run('selene', ['--display-style=quiet', 'src'], wt);
  const sty = run('stylua', ['--check', 'src'], wt);

  const all = [];
  let failed = false;
  for (const [name, r, parse] of [['luau-lsp', lsp, parseLsp], ['selene', sel, parseSelene], ['stylua', sty, parseStylua]]) {
    const items = parse(r.text, wt);
    const errs = items.filter((i) => i.severity === 'error');
    if (r.status !== 0) {
      failed = true;
      // 종료 코드가 실패인데 오류로 분류된 줄이 없으면 경고 줄을 오류로 취급, 그것도 없으면 원문 꼬리
      const use = errs.length ? errs : items.length ? items
        : [{ tool: name, severity: 'error', file: '', line: 0, kind: 'exit', msg: `종료 코드 ${r.status}: ${tailMsg(r.text)}` }];
      all.push(...use.map((i) => ({ ...i, severity: 'error' })));
    } else {
      all.push(...items);
    }
  }
  const errors = all.filter((i) => i.severity === 'error');
  const warnings = all.filter((i) => i.severity !== 'error');
  const result = failed || errors.length ? 'fail' : 'pass';
  return { result, exit_code: result === 'pass' ? 0 : 1, duration_s: +((Date.now() - t0) / 1000).toFixed(1), errors, warnings_count: warnings.length, notes, work };
}

function report(res) {
  const jsonPath = path.join(res.work, 'result.json');
  const { work, ...out } = res;
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  const label = { pass: '통과', fail: '검사 실패' }[res.result];
  const lines = [`[${label}] 오류 ${res.errors.length}, 경고 ${res.warnings_count}, ${res.duration_s}s`];
  for (const e of res.errors.slice(0, MAX_ERRORS)) lines.push(`  ${e.file}${e.line ? ':' + e.line : ''} ${e.tool}/${e.kind} ${e.msg}`);
  if (res.errors.length > MAX_ERRORS) lines.push(`  … 외 ${res.errors.length - MAX_ERRORS}개 (JSON 참고)`);
  for (const n of res.notes) lines.push(`  · ${n}`);
  lines.push(`JSON: ${posix(jsonPath)}`);
  console.log(lines.join('\n'));
}

function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const pos = argv.filter((a) => !a.startsWith('--'));
  try {
    if (pos[0] === 'new') return cmdNew(pos[1], flags.has('--no-gate'));
    if (pos[0] === 'remove') return cmdRemove(pos[1], flags.has('--force'));
    const target = pos[0] === 'check' ? pos[1] : pos[0];
    if (!target) throw new Stop(2, '사용법: node check.js <worktree 경로|이름> | new <이름> [--no-gate] | remove <이름> [--force]');
    const res = runCheck(target);
    report(res);
    process.exitCode = res.exit_code;
  } catch (e) {
    if (e instanceof Stop) { console.log(`[검사 불가] ${e.message}`); process.exitCode = e.code; return; }
    console.log(`[검사 불가] 예기치 않은 오류: ${e.stack || e}`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main();
}
