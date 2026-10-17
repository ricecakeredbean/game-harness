// 언어 서버(csharp-ls, luau-lsp) 프로세스 하나를 띄우고 JSON-RPC(LSP) 로 대화하는 클라이언트
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const EXE = process.platform === 'win32' ? '.exe' : '';
const CSHARP_EXE = path.join(os.homedir(), '.dotnet', 'tools', 'csharp-ls' + EXE);
const LUAU_EXE = path.join(os.homedir(), '.rokit', 'bin', 'luau-lsp' + EXE);

function toUri(p) {
  const s = path.resolve(p).replace(/\\/g, '/');
  // 드라이브 문자는 대문자 + 콜론 인코딩 없이 (csharp-ls 응답 형식과 맞춤)
  return 'file:///' + s.split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, (_, d) => d.toUpperCase() + ':');
}
function fromUri(uri) {
  if (!uri.startsWith('file://')) return null;
  let p = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''));
  if (process.platform === 'win32') p = p.replace(/\//g, '\\');
  else p = '/' + p;
  return path.normalize(p);
}

// cmd: { name, exe, args, settings? } — settings 는 workspace/configuration 에 섹션 이름으로 답한다
class LspClient extends EventEmitter {
  constructor(root, cmd, log) {
    super();
    this.root = root;
    this.cmd = cmd;
    this.name = cmd.name;
    this.log = log || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.alive = false;
  }

  start() {
    this.proc = spawn(this.cmd.exe, this.cmd.args, { cwd: this.root, windowsHide: true });
    this.alive = true;
    this.proc.stderr.on('data', d => this.log(`[${this.name}] ` + d.toString().trimEnd()));
    this.proc.stdout.on('data', c => this._onData(c));
    this.proc.on('exit', code => {
      this.alive = false;
      this.log(`${this.name} 종료 (code ${code})`);
      for (const p of this.pending.values()) p.reject(new Error(`${this.name} 종료됨`));
      this.pending.clear();
      this.emit('exit', code);
    });
    this.proc.on('error', e => { this.log(`${this.name} 실행 실패: ` + e.message); });
  }

  stop() {
    if (!this.proc || !this.alive) return Promise.resolve();
    return new Promise(res => {
      const t = setTimeout(() => { try { this.proc.kill(); } catch {} }, 3000);
      this.proc.once('exit', () => { clearTimeout(t); res(); });
      // 정상 종료 시도 후 안 되면 kill
      this.request('shutdown', null).then(() => this.notify('exit', null)).catch(() => {});
    });
  }

  _send(msg) {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  request(method, params) {
    if (!this.alive) return Promise.reject(new Error(`${this.name} 가 실행 중이 아님`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) {
    if (this.alive) this._send({ jsonrpc: '2.0', method, params });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buf.slice(0, sep).toString());
      const len = m ? +m[1] : 0;
      if (this.buf.length < sep + 4 + len) return;
      const msg = JSON.parse(this.buf.slice(sep + 4, sep + 4 + len).toString('utf8'));
      this.buf = this.buf.slice(sep + 4 + len);
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg.id !== undefined && msg.method) {
      // 서버 → 클라 요청: configuration 은 settings 의 섹션(없으면 null) 배열, 나머지는 null
      const settings = this.cmd.settings || {};
      const result = msg.method === 'workspace/configuration' ? (msg.params.items || []).map(i => settings[i.section] ?? null) : null;
      this._send({ jsonrpc: '2.0', id: msg.id, result });
      if (msg.method === 'workspace/configuration') this.emit('configuration');
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.emit('notification', msg);
    }
  }

  async initialize() {
    const rootUri = toUri(this.root);
    await this.request('initialize', {
      processId: process.pid, rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
      capabilities: {
        window: { workDoneProgress: true },
        workspace: { configuration: true, symbol: {}, didChangeWatchedFiles: { dynamicRegistration: true } },
        textDocument: {
          references: {}, definition: {}, hover: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          synchronization: { didSave: true },
        },
      },
    });
    this.notify('initialized', {});
  }
}

module.exports = { LspClient, toUri, fromUri, CSHARP_EXE, LUAU_EXE };
