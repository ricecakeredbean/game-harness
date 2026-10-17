#!/usr/bin/env node
// worktree 외부 컴파일 검사 (에디터·Library 없이 main 의 csproj/Library 를 빌려 dotnet build).
// 사용법은 README.md 참고. 종료 코드: 0=통과 1=컴파일 실패 2=검사 불가(차단·미지원 포함)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

// main 프로젝트 폴더: UNITY_CHECK_MAIN → 인자로 준 경로(없으면 현재 폴더)가 속한 git 저장소의 main worktree
function findMain() {
  if (process.env.UNITY_CHECK_MAIN) return path.resolve(process.env.UNITY_CHECK_MAIN);
  const p = process.argv.slice(2).find((a) => !a.startsWith('--') && fs.existsSync(a));
  const r = cp.spawnSync('git', ['-C', p || process.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const common = (r.stdout || '').trim();
  if (r.status === 0 && path.basename(common) === '.git') return path.dirname(path.resolve(common));
  console.error('main 프로젝트를 찾지 못함 — 프로젝트(또는 그 worktree) 폴더에서 실행하거나 UNITY_CHECK_MAIN 환경변수로 지정');
  process.exit(2);
}
const MAIN = findMain();
const WT_ROOT = MAIN + '-wt';
const BASE = process.env.UNITY_CHECK_BASE || 'main';
const MAX_ERRORS = 20;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

const posix = (p) => p.replace(/\\/g, '/');
const win = (p) => p.replace(/\//g, '\\');
const lc = (p) => posix(p).toLowerCase();

function git(cwd, args, opt = {}) {
  const r = cp.spawnSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opt });
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() };
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
  // 워커가 승인 없이 컴파일 검사를 직접 돌릴 수 있게 check.js 실행만 허용
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

// worktree 별 임시 작업 폴더 (재실행 시 증분 빌드를 위해 재사용)
function workDirFor(wt) {
  const h = crypto.createHash('sha1').update(lc(wt)).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), 'unity-check', `${path.basename(wt)}-${h}`);
}

// ---------- 변경 목록 (브랜치 diff + 작업 트리) ----------
function collectChanges(wt) {
  const added = new Set(), deleted = new Set(), touched = new Set();
  const d = git(wt, ['diff', '--no-renames', '--name-status', '-z', `${BASE}...HEAD`]);
  if (!d.ok) throw new Stop(2, `git diff ${BASE}...HEAD 실패: ${d.err}`);
  const t = d.out.split('\0');
  for (let i = 0; i + 1 < t.length; i += 2) {
    const st = t[i][0], p = t[i + 1];
    touched.add(p);
    if (st === 'A') added.add(p); else if (st === 'D') deleted.add(p);
  }
  const s = git(wt, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames']);
  if (!s.ok) throw new Stop(2, `git status 실패: ${s.err}`);
  for (const e of s.out.split('\0')) {
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), p = e.slice(3);
    touched.add(p);
    if (xy === '??' || xy.includes('A')) { added.add(p); deleted.delete(p); }
    else if (xy.includes('D')) { deleted.add(p); added.delete(p); }
  }
  return { added, deleted, touched };
}

// ---------- 어셈블리 소속 판정 ----------
function makeAsmResolver(wt) {
  const dirCache = new Map();
  const list = (rel) => {
    if (!dirCache.has(rel)) {
      let names = [];
      try { names = fs.readdirSync(path.join(wt, rel)); } catch { /* 없음 */ }
      dirCache.set(rel, names);
    }
    return dirCache.get(rel);
  };
  return function resolve(rel) { // rel: worktree 기준 posix 경로 (.cs)
    let dir = path.posix.dirname(rel);
    while (dir && dir !== '.') {
      const names = list(dir);
      const asmdef = names.find((n) => n.endsWith('.asmdef'));
      if (asmdef) {
        let name;
        try {
          name = JSON.parse(fs.readFileSync(path.join(wt, dir, asmdef), 'utf8').replace(/^\uFEFF/, '')).name;
        } catch { return { err: `asmdef 파싱 실패: ${dir}/${asmdef}` }; }
        return { name };
      }
      if (names.some((n) => n.endsWith('.asmref'))) return { err: `asmref 미지원: ${dir}` };
      dir = path.posix.dirname(dir);
    }
    if (rel.startsWith('Packages/')) return { err: `asmdef 없는 Packages 소스 미지원: ${rel}` };
    return { name: classicAsm(rel) };
  };
}
// Assembly-CSharp 계열 이름 규칙: firstpass / Editor / Editor-firstpass
function classicAsm(rel) {
  const segs = rel.split('/');
  const first = ['Plugins', 'Standard Assets', 'Pro Standard Assets'].includes(segs[1]);
  const editor = segs.slice(1, -1).includes('Editor');
  return 'Assembly-CSharp' + (editor ? '-Editor' : '') + (first ? '-firstpass' : '');
}

const hiddenPath = (rel) => rel.split('/').some((s) => s.startsWith('.') || s.endsWith('~'));

// ---------- .meta 생성 ----------
const guid = () => crypto.randomBytes(16).toString('hex');
function metaFor(file, isDir) {
  const head = `fileFormatVersion: 2\nguid: ${guid()}\n`;
  if (isDir) return head + 'folderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n';
  const ext = path.extname(file).toLowerCase();
  if (ext === '.cs') return head + 'MonoImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n';
  if (ext === '.asmdef') return head + 'AssemblyDefinitionImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n';
  if (['.txt', '.json', '.md', '.xml', '.csv', '.yml', '.yaml'].includes(ext)) return head + 'TextScriptImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n';
  if (ext === '.dll') return head; // 플러그인 설정은 에디터가 채움
  return head + 'DefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n';
}

function generateMetas(wt, added) {
  let n = 0;
  const make = (rel, isDir) => {
    const mp = path.join(wt, rel + '.meta');
    if (fs.existsSync(mp)) return;
    fs.writeFileSync(mp, metaFor(rel, isDir));
    n++;
  };
  for (const rel of added) {
    if (!rel.startsWith('Assets/') || rel.endsWith('.meta') || hiddenPath(rel)) continue;
    if (!fs.existsSync(path.join(wt, rel))) continue;
    make(rel, false);
    for (let dir = path.posix.dirname(rel); dir !== 'Assets' && dir !== '.'; dir = path.posix.dirname(dir)) make(dir, true);
  }
  return n;
}

// ---------- csproj 사본 생성 ----------
const isAbs = (p) => /^[A-Za-z]:/.test(p) || p.startsWith('\\\\');
const rootFor = (rel, wt) => (/^library[\\/]/i.test(rel) ? MAIN : wt);

function buildProjects(wt, projDir, addByAsm, extraRefs, notes) {
  fs.mkdirSync(projDir, { recursive: true });
  const names = fs.readdirSync(MAIN).filter((f) => f.endsWith('.csproj'));
  const dropped = [];
  const outputs = new Map();
  let removed = 0, added = 0;

  for (const f of names) {
    const asm = f.replace(/\.csproj$/, '');
    let txt = fs.readFileSync(path.join(MAIN, f), 'utf8');
    const seen = new Set();
    let count = 0;
    // Compile: 상대 → worktree 절대. worktree 에 없는 파일(삭제·이름 변경)은 뺀다
    txt = txt.replace(/^[ \t]*<Compile Include="([^"]+)"\s*\/>[ \t]*\r?\n/gm, (m, p) => {
      if (isAbs(p)) { count++; return m; }
      const abs = path.join(rootFor(p, wt), p);
      if (!/^library[\\/]/i.test(p) && !fs.existsSync(abs)) { removed++; return ''; }
      seen.add(lc(p));
      count++;
      return m.replace(p, abs);
    });
    txt = txt.replace(/(<(?:None|Content|EmbeddedResource|AdditionalFiles) Include=")([^"]+)(")/g,
      (m, a, p, b) => (isAbs(p) || p.endsWith('.csproj') ? m : a + path.join(rootFor(p, wt), p) + b));
    txt = txt.replace(/(<HintPath>)([^<]+)(<\/HintPath>)/g,
      (m, a, p, b) => (isAbs(p) ? m : a + path.join(rootFor(p, wt), p) + b));

    let extra = '';
    for (const rel of addByAsm.get(asm) || []) {
      if (seen.has(lc(win(rel)))) continue;
      extra += `    <Compile Include="${path.join(wt, rel)}" />\n`;
      count++; added++;
    }
    for (const r of extraRefs.get(asm) || []) {
      extra += `    <Reference Include="${path.basename(r, '.dll')}"><HintPath>${path.join(wt, r)}</HintPath><Private>False</Private></Reference>\n`;
    }
    if (extra) {
      const block = `  <ItemGroup>\n${extra}  </ItemGroup>\n`;
      const imp = /^[ \t]*<Import Project="\$\(MSBuildToolsPath\)[^"]*Microsoft\.CSharp\.targets"[^>]*\/>/m;
      txt = imp.test(txt) ? txt.replace(imp, (m) => block + m) : txt.replace('</Project>', block + '</Project>');
    }
    if (count === 0) { dropped.push(asm); continue; }
    outputs.set(f, txt);
  }
  // 소스가 하나도 안 남은 프로젝트는 빌드에서 빼고 참조도 지운다
  for (const asm of dropped) {
    const re = new RegExp(`[ \\t]*<ProjectReference Include="${asm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.csproj">[\\s\\S]*?</ProjectReference>\\r?\\n?`, 'g');
    for (const [f, t] of outputs) outputs.set(f, t.replace(re, ''));
  }
  // 내용이 같으면 다시 쓰지 않는다 (mtime 이 바뀌면 증분 빌드가 깨진다)
  for (const [f, t] of outputs) {
    const p = path.join(projDir, f);
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== t) fs.writeFileSync(p, t);
  }
  for (const f of fs.readdirSync(projDir)) {
    if (f.endsWith('.csproj') && !outputs.has(f)) fs.rmSync(path.join(projDir, f));
  }
  const all = '<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n' +
    '  <ItemGroup><P Include="*.csproj" /></ItemGroup>\n' +
    '  <Target Name="Build"><MSBuild Projects="@(P)" Targets="Build" /></Target>\n</Project>\n';
  const allPath = path.join(projDir, 'all.proj');
  if (!fs.existsSync(allPath) || fs.readFileSync(allPath, 'utf8') !== all) fs.writeFileSync(allPath, all);

  if (removed) notes.push(`worktree 에 없는 .cs ${removed}개를 컴파일 목록에서 뺌`);
  if (added) notes.push(`새 .cs ${added}개를 컴파일 목록에 추가`);
  if (dropped.length) notes.push(`소스가 없어 빌드 제외: ${dropped.join(', ')}`);
  return { allPath, built: [...outputs.keys()].map((f) => f.replace(/\.csproj$/, '')) };
}

// ---------- 빌드 출력 파싱 ----------
function parseBuild(text, wt) {
  const rel = (f) => {
    const p = posix(f.trim());
    const w = posix(wt).toLowerCase() + '/', m = posix(MAIN).toLowerCase() + '/';
    if (p.toLowerCase().startsWith(w)) return p.slice(w.length);
    if (p.toLowerCase().startsWith(m)) return '(main)/' + p.slice(m.length);
    return p;
  };
  const errors = [], seen = new Set();
  let warnings = 0;
  const warnSeen = new Set();
  const withFile = /^(.+?)\((\d+)(?:,\d+)?(?:,\d+,\d+)?\):\s+(error|warning)\s+([A-Za-z]+\d+):\s+(.*?)(?:\s+\[[^\]]+\])?\s*$/;
  const noFile = /^(?:.*?:\s+)?(error|warning)\s+([A-Za-z]+\d+):\s+(.*?)(?:\s+\[[^\]]+\])?\s*$/;
  for (const line of text.split(/\r?\n/)) {
    let m = withFile.exec(line), file, ln, kind, code, msg;
    if (m) { [, file, ln, kind, code, msg] = m; file = rel(file); ln = +ln; }
    else if ((m = noFile.exec(line))) { [, kind, code, msg] = m; file = ''; ln = 0; }
    else continue;
    if (code === 'MSB4181') continue; // 하위 프로젝트 실패의 중복 신호
    const key = `${file}|${ln}|${code}|${msg}`;
    if (kind === 'warning') { if (!warnSeen.has(key)) { warnSeen.add(key); warnings++; } continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({ file, line: ln, code, msg: msg.length > 300 ? msg.slice(0, 300) + '…' : msg });
  }
  return { errors, warnings };
}

// ---------- 검사 ----------
function runCheck(arg, opt) {
  const t0 = Date.now();
  const notes = [];
  const wt = path.resolve(fs.existsSync(arg) ? arg : path.join(WT_ROOT, arg));
  if (!fs.existsSync(path.join(wt, 'Assets'))) throw new Stop(2, `Unity 프로젝트 worktree 가 아님: ${posix(wt)}`);
  if (lc(wt) === lc(MAIN)) throw new Stop(2, 'main 폴더는 검사하지 않는다 (에디터에서 확인)');
  if (!fs.existsSync(path.join(MAIN, 'Assembly-CSharp.csproj'))) throw new Stop(2, `main 에 csproj 없음: ${posix(MAIN)} (에디터로 한 번 열어 생성)`);
  if (!fs.existsSync(path.join(MAIN, 'Library'))) throw new Stop(2, 'main 에 Library 없음');

  const { added, deleted, touched } = collectChanges(wt);

  // 차단: 패키지 변경
  const pk = ['Packages/manifest.json', 'Packages/packages-lock.json'].filter((p) => touched.has(p));
  if (pk.length) throw new Stop(2, `패키지 변경은 main 에서 하세요 (브랜치에서 변경됨: ${pk.join(', ')})`);

  // 미지원: 새 asmdef / asmref
  const newAsm = [...added].filter((p) => /\.(asmdef|asmref)$/.test(p) && fs.existsSync(path.join(wt, p)));
  if (newAsm.length) throw new Stop(2, `새 asmdef 는 미지원 (csproj 생성 필요): ${newAsm.join(', ')}`);
  const chgAsm = [...touched].filter((p) => p.endsWith('.asmdef') && !added.has(p));
  if (chgAsm.length) notes.push(`asmdef 수정/삭제는 csproj 에 반영되지 않음: ${chgAsm.join(', ')}`);

  // 새 .cs → 소속 어셈블리, 새 플러그인 DLL → 참조
  const resolve = makeAsmResolver(wt);
  const addByAsm = new Map(), extraRefs = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const rel of added) {
    if (hiddenPath(rel) || !fs.existsSync(path.join(wt, rel))) continue;
    if (rel.endsWith('.cs') && (rel.startsWith('Assets/') || rel.startsWith('Packages/'))) {
      const r = resolve(rel);
      if (r.err) throw new Stop(2, r.err);
      const asm = r.name;
      if (!fs.existsSync(path.join(MAIN, asm + '.csproj'))) throw new Stop(2, `소속 어셈블리 ${asm} 의 csproj 가 main 에 없음 (미지원): ${rel}`);
      push(addByAsm, asm, rel);
    } else if (rel.startsWith('Assets/') && rel.endsWith('.dll')) {
      const editorOnly = rel.split('/').slice(1, -1).includes('Editor');
      for (const a of ['Assembly-CSharp', 'Assembly-CSharp-firstpass', 'Assembly-CSharp-Editor', 'Assembly-CSharp-Editor-firstpass']) {
        if (editorOnly && !a.includes('Editor')) continue;
        if (fs.existsSync(path.join(MAIN, a + '.csproj'))) push(extraRefs, a, rel);
      }
      notes.push(`새 플러그인 DLL 을 참조에 추가: ${rel}`);
    }
  }
  if (deleted.size) notes.push(`삭제된 파일 ${deleted.size}개`);

  if (!opt.noMeta) {
    const n = generateMetas(wt, added);
    if (n) notes.push(`.meta ${n}개 생성`);
  }

  const work = workDirFor(wt);
  const projDir = path.join(work, 'proj'), outDir = path.join(work, 'out'), objDir = path.join(work, 'obj');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(objDir, { recursive: true });
  const { allPath, built } = buildProjects(wt, projDir, addByAsm, extraRefs, notes);

  const dotnetArgs = ['build', allPath, '-nologo', '-v:q', '-clp:NoSummary', '-nodeReuse:false',
    '-p:UseSharedCompilation=false',
    `-p:OutputPath=${outDir}\\`, `-p:BaseIntermediateOutputPath=${objDir}\\`, `-p:IntermediateOutputPath=${objDir}\\`];
  const b = cp.spawnSync('dotnet', dotnetArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: BUILD_TIMEOUT_MS, cwd: work });
  if (b.error) throw new Stop(2, `dotnet 실행 실패: ${b.error.message}`);
  const text = (b.stdout || '') + '\n' + (b.stderr || '');
  const { errors, warnings } = parseBuild(text, wt);
  const assemblies = built.filter((a) => fs.existsSync(path.join(outDir, a + '.dll'))).sort();

  let result, code;
  if (b.status === 0 && !errors.length) { result = 'pass'; code = 0; }
  else if (errors.length) { result = 'fail'; code = 1; }
  else { result = 'unavailable'; code = 2; notes.push('빌드 실패했으나 오류 줄을 못 읽음: ' + text.trim().split(/\r?\n/).slice(-5).join(' | ').slice(0, 500)); }
  return { result, exit_code: code, duration_s: +((Date.now() - t0) / 1000).toFixed(1), assemblies, errors, warnings_count: warnings, notes, work };
}

function report(res) {
  const jsonPath = path.join(res.work, 'result.json');
  const { work, ...out } = res;
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  const label = { pass: '통과', fail: '컴파일 실패', unavailable: '검사 불가' }[res.result];
  const lines = [`[${label}] 오류 ${res.errors.length}, 경고 ${res.warnings_count}, ${res.duration_s}s, 어셈블리 ${res.assemblies.length}개`];
  for (const e of res.errors.slice(0, MAX_ERRORS)) lines.push(`  ${e.file}${e.line ? ':' + e.line : ''} ${e.code} ${e.msg}`);
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
    if (!target) throw new Stop(2, '사용법: node check.js <worktree 경로|이름> [--no-meta] | new <이름> | remove <이름> [--force]');
    const res = runCheck(target, { noMeta: flags.has('--no-meta') });
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
