// lsp-relay CLI: 데몬이 없으면 띄우고 /api/<tool> 로 질의한다
// 예) node cli.js refs PlayerController AudioManager --filter Assets/Scripts --context 1
//     node cli.js refs Greeter --project test-fixture
//     node cli.js workspace D:/Other/Proj --name Other --pinned
const { spawn } = require('child_process');
const path = require('path');

const BASE = `http://127.0.0.1:${+process.env.LSP_RELAY_PORT || 7420}`;
const USAGE = `사용법 (--project <이름|root> 생략 시 기본 프로젝트):
  node cli.js refs <심볼...> [--context N] [--filter 경로] [--limit N] [--project P]
  node cli.js defs <심볼...> [--project P]
  node cli.js outline <파일...> [--project P]
  node cli.js workspace                                  프로젝트 목록
  node cli.js workspace <root> [solution] [--name N] [--pinned] [--lang luau]   프로젝트 추가
  node cli.js status | stop`;

async function health() {
  try {
    const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// 데몬을 분리 실행하고 /health 가 응답할 때까지 기다린다
async function ensureDaemon() {
  if (await health()) return false;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname,
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await health()) return true;
  }
  throw new Error('데몬이 20초 안에 뜨지 않았다 (relay.log 확인)');
}

async function call(tool, body) {
  const r = await fetch(`${BASE}/api/${tool}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text.replace(/^오류: /, ''));
  return text;
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    // 값 없는 플래그(--pinned)는 true
    if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1] === undefined || rest[i + 1].startsWith('--') ? true : rest[++i];
    else pos.push(rest[i]);
  }
  if (!cmd || cmd === 'help' || cmd === '-h') return console.log(USAGE);

  if (cmd === 'status') return console.log(JSON.stringify(await health() || { ok: false, msg: '데몬 없음' }, null, 2));
  if (cmd === 'stop') {
    if (!(await health())) return console.log('데몬 없음');
    return console.log(await call('shutdown', {}).catch(() => '종료한다'));
  }

  let body;
  const project = opts.project;
  if (cmd === 'refs') body = { project, symbols: pos, context_lines: opts.context && +opts.context, path_filter: opts.filter, limit: opts.limit && +opts.limit };
  else if (cmd === 'defs') body = { project, symbols: pos };
  else if (cmd === 'outline') body = { project, files: pos };
  else if (cmd === 'workspace') body = { root: pos[0], solution: pos[1], name: opts.name, pinned: opts.pinned ? true : undefined, lang: opts.lang };
  else { console.error(USAGE); process.exit(2); }

  await ensureDaemon();
  console.log(await call(cmd, body));
})().catch(e => { console.error('오류: ' + e.message); process.exitCode = 1; }); // exit() 는 Windows 에서 fetch 소켓 정리 중 libuv assert 가 난다
