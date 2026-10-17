#!/usr/bin/env node
// 워커 완료 게이트 (Stop 훅). check.js 로 worktree 를 검사해 깨졌으면 종료를 막는다.
// 종료 코드: 0=종료 허용, 2=종료 막음(stderr 가 모델에 전달됨). 결과 JSON 은 README 참고
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const CHECK = path.join(__dirname, 'check.js');
const MAX_FAILS = 3;
const TOP = 10;
const BLOCK_MARK = '프로젝트 설정 변경';

const posix = (p) => p.replace(/\\/g, '/');
const lc = (p) => posix(p).toLowerCase();

function git(cwd, args) {
  const r = cp.spawnSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// 게이트 상태·결과 폴더 (worktree 밖)
function gateDirFor(wt) {
  const h = crypto.createHash('sha1').update(lc(wt)).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), 'roblox-check', 'gate', `${path.basename(wt)}-${h}`);
}

// 검사 대상 파일의 지문: HEAD + 작업 트리의 소스·검사 설정 변경 내용
const WATCHED = /\.(lua|luau)$|^(default\.project\.json|rokit\.toml|selene\.toml|stylua\.toml|\.luaurc)$|\.rbxlx?$|^tools\//;
function fingerprint(wt) {
  const head = (git(wt, ['rev-parse', 'HEAD']) || '').trim();
  const st = git(wt, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames']) || '';
  const h = crypto.createHash('sha1').update(head);
  for (const e of st.split('\0').sort()) {
    if (e.length < 4) continue;
    const p = e.slice(3);
    if (!WATCHED.test(p) && !WATCHED.test(path.posix.basename(p))) continue;
    h.update(e);
    try { h.update(fs.readFileSync(path.join(wt, p))); } catch { h.update('-'); }
  }
  return h.digest('hex');
}

function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* 입력 없음 */ }
  const wt = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const top = git(wt, ['rev-parse', '--show-toplevel']);
  if (!top) return 0; // git worktree 아님 → 관여 안 함
  const root = path.resolve(top.trim());

  const dir = gateDirFor(root);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.json'), resultPath = path.join(dir, 'result.json');
  const state = readJson(statePath, { pass_fp: null, consecutive_failures: 0 });
  const fp = fingerprint(root);
  const t0 = Date.now();

  const finish = (result, code, errors, msg, extra = {}) => {
    const out = { time: new Date().toISOString(), worktree: posix(root), result, exit_code: code,
      errors_top: errors.slice(0, TOP), consecutive_failures: state.consecutive_failures,
      stop_hook_active: !!input.stop_hook_active, duration_s: +((Date.now() - t0) / 1000).toFixed(1), ...extra };
    fs.writeFileSync(resultPath, JSON.stringify(out, null, 2));
    fs.appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify(out) + '\n');
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    if (msg) process.stderr.write(msg + '\n');
    return code;
  };

  // 마지막 통과 이후 변경 없음 → 검사 생략
  if (state.pass_fp === fp) return finish('pass', 0, [], null, { skipped: true });

  const r = cp.spawnSync(process.execPath, [CHECK, root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = (r.stdout || '') + (r.stderr || '');
  const m = /^JSON: (.+)$/m.exec(text);
  const res = m ? readJson(m[1].trim(), null) : null;
  const errors = res && res.errors ? res.errors.map((e) => `${e.file}${e.line ? ':' + e.line : ''} ${e.tool}/${e.kind} ${e.msg}`) : [];

  if (r.status === 0) {
    state.pass_fp = fp; state.consecutive_failures = 0;
    return finish('pass', 0, [], null);
  }
  const firstLine = text.trim().split(/\r?\n/)[0] || '';
  const blocked = r.status === 2 && firstLine.includes(BLOCK_MARK);
  if (r.status === 2 && !blocked) { // 미지원·환경 문제 → 막지 않고 경고만
    return finish('unsupported', 0, [], `[완료 게이트] 경고: 검사를 못 함 — ${firstLine}`, { warning: firstLine });
  }

  state.pass_fp = null;
  state.consecutive_failures++;
  if (state.consecutive_failures >= MAX_FAILS) { // 루프 방지: 종료 허용 + 기록 (매니저가 상향 판단)
    const n = state.consecutive_failures;
    state.consecutive_failures = 0;
    return finish(blocked ? 'project_blocked' : 'fail', 0, errors,
      `[완료 게이트] 연속 ${n}회 실패 — 종료를 허용하고 실패를 기록함`, { gave_up: true, consecutive_failures: n });
  }
  if (blocked) {
    return finish('project_blocked', 2, [], `[완료 게이트] ${firstLine.replace(/^\[검사 불가\] /, '')}\n` +
      '브랜치에서 default.project.json·rokit.toml·*.rbxl 변경을 되돌린 뒤(git checkout <기준브랜치> -- <파일>) 다시 끝내라. 필요하면 보고에 적어 매니저에게 맡겨라(main 에서 처리).');
  }
  const lines = errors.slice(0, TOP);
  return finish('fail', 2, errors,
    `[완료 게이트] 검사 실패 (오류 ${errors.length}개, 연속 ${state.consecutive_failures}/${MAX_FAILS})\n` +
    lines.map((l) => '  ' + l).join('\n') + (errors.length > TOP ? `\n  … 외 ${errors.length - TOP}개` : '') +
    `\n오류를 고친 뒤 다시 끝내라. (직접 확인: node ${posix(CHECK)} ${posix(root)})`);
}

try { process.exitCode = main(); }
catch (e) { process.stderr.write(`[완료 게이트] 내부 오류, 종료 허용: ${e.message}\n`); process.exitCode = 0; }
