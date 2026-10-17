// LSP 중계 데몬: 프로젝트마다 언어 서버(csharp-ls / luau-lsp)를 하나씩 상주시키고 MCP(/mcp)·JSON API(/api/<tool>)로 질의를 받는다
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = require('zod');
const { Relay } = require('./relay');

const PORT = +process.env.LSP_RELAY_PORT || 7420;
const HOST = '127.0.0.1';
// 설정·로그는 코드 폴더 밖에 둔다 (플러그인을 업데이트해도 유지): LSP_RELAY_HOME → ~/.lsp-relay
const HOME = process.env.LSP_RELAY_HOME || path.join(os.homedir(), '.lsp-relay');
fs.mkdirSync(HOME, { recursive: true });
const LOG_FILE = path.join(HOME, 'relay.log');
const CONFIG_FILE = path.join(HOME, 'projects.json');

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('sv-SE')}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const relay = new Relay(log, CONFIG_FILE);
const PROJECT = z.string().optional().describe('프로젝트 이름 또는 root 경로 (생략하면 기본 프로젝트). 목록은 workspace 도구');

// 도구 정의: MCP 와 API 가 같은 핸들러를 쓴다
const TOOLS = {
  refs: {
    description: 'C#·Luau 심볼 참조 찾기 (grep 대신). 심볼 여러 개를 한 번에 받아 심볼별 정의 위치와 참조를 파일별로 묶어 "줄번호 | 줄 내용" 으로 준다. C# 표기: Type, Ns.Type, Type.Member. Luau 표기: Module, Module.func, 폴더.Module.func, 파일.luau:이름, 이름만. 동명 후보는 "이름@경로일부" 로 좁힌다.',
    shape: {
      project: PROJECT,
      symbols: z.array(z.string()).describe('심볼 목록. 예: ["AudioManager", "PlayerShip.TakeDamage"] / Luau ["Util", "Util.add", "shared.Util.add"]'),
      context_lines: z.number().int().min(0).max(10).optional().describe('참조 줄 앞뒤로 보여줄 줄 수 (기본 0)'),
      path_filter: z.string().optional().describe('참조 파일 상대경로 필터. 부분 문자열 또는 글롭(* / **). 예: "Assets/Scripts"'),
      limit: z.number().int().min(1).optional().describe('심볼당 출력할 참조 줄 상한 (기본 80, 넘치면 "외 N개")'),
    },
    run: a => relay.refs(a),
  },
  defs: {
    description: 'C#·Luau 심볼 정의 위치와 시그니처 한 줄. 심볼 여러 개를 한 번에 받는다. 표기는 refs 와 같다.',
    shape: { project: PROJECT, symbols: z.array(z.string()).describe('심볼 목록') },
    run: a => relay.defs(a),
  },
  outline: {
    description: '파일별 타입·멤버 목록 (줄번호 종류 이름 : 타입). .cs 와 .luau(최상위 함수·변수·타입) 지원. 경로는 프로젝트 루트 기준 상대경로 또는 절대경로.',
    shape: { project: PROJECT, files: z.array(z.string()).describe('파일 경로 목록') },
    run: a => relay.outline(a),
  },
  workspace: {
    description: '프로젝트 목록(인자 없음) 또는 프로젝트 추가(root). 추가해도 다른 세션의 기본 프로젝트는 바뀌지 않는다. 추가한 프로젝트는 다른 도구에 project 인자로 쓰고, 첫 질의 때 로드된다(큰 솔루션은 수십 초).',
    shape: {
      root: z.string().optional().describe('추가할 프로젝트의 기준 폴더 절대경로 (생략하면 목록만)'),
      name: z.string().optional().describe('프로젝트 이름 (생략하면 폴더 이름)'),
      solution: z.string().optional().describe('.sln 경로 (생략하면 root 의 유일한 .sln, luau 는 안 씀)'),
      lang: z.enum(['csharp', 'luau']).optional().describe('언어 (기본 csharp). luau 는 root 에 default.project.json(Rojo) 이 있어야 한다'),
      pinned: z.boolean().optional().describe('true 면 자동 종료하지 않고 데몬 시작 시 미리 로드'),
    },
    run: a => relay.workspace(a),
  },
};

function buildMcp() {
  const server = new McpServer({ name: 'lsp-relay', version: '2.0.0' });
  for (const [name, t] of Object.entries(TOOLS)) {
    server.registerTool(name, { description: t.description, inputSchema: t.shape }, async args => {
      try {
        return { content: [{ type: 'text', text: await t.run(args) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: '오류: ' + e.message }], isError: true };
      }
    });
  }
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('JSON 파싱 실패: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, pid: process.pid, ...relay.status() }, 'application/json');

    if (url.pathname === '/mcp') {
      // 상태 없는 모드: 요청마다 서버·트랜스포트를 새로 만든다 (여러 세션 동시 접속)
      if (req.method !== 'POST') return send(res, 405, JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }), 'application/json');
      const body = await readBody(req);
      const server = buildMcp();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    const m = /^\/api\/(\w+)$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      if (m[1] === 'shutdown') {
        send(res, 200, '종료한다');
        log('shutdown 요청');
        await relay.shutdown();
        process.exit(0);
      }
      const tool = TOOLS[m[1]];
      if (!tool) return send(res, 404, `없는 도구: ${m[1]} (refs, defs, outline, workspace)`);
      const args = await readBody(req);
      const t0 = Date.now();
      const text = await tool.run(args);
      log(`api ${m[1]} ${JSON.stringify(args).slice(0, 120)} → ${Date.now() - t0}ms`);
      return send(res, 200, text);
    }
    send(res, 404, '없는 경로');
  } catch (e) {
    log(`오류 ${url.pathname}: ${e.message}`);
    if (!res.headersSent) send(res, 500, '오류: ' + e.message);
  }
});

httpServer.on('error', e => {
  log(e.code === 'EADDRINUSE' ? `포트 ${PORT} 사용 중 — 이미 데몬이 떠 있을 수 있다` : `HTTP 오류: ${e.message}`);
  process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
  log(`lsp-relay 시작 http://${HOST}:${PORT} (pid ${process.pid})`);
  log(relay.list());
  relay.preloadPinned();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await relay.shutdown(); process.exit(0); });
