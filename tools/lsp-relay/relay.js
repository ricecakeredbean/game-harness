// 프로젝트별 워크스페이스(언어 서버 1개씩: csharp-ls 또는 luau-lsp) 관리 + 도구 로직(refs/defs/outline/workspace). MCP·API 가 같이 쓴다.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { LspClient, toUri, fromUri, CSHARP_EXE, LUAU_EXE } = require('./lsp');

const SKIP_DIRS = new Set(['library', 'temp', 'logs', 'obj', 'bin', '.git', 'node_modules', 'builds', 'usersettings', '.vs', '.idea']);
const TYPE_KINDS = new Set([5, 10, 11, 23]); // class, enum, interface, struct
const KIND_NAMES = { 3: 'namespace', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'ctor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'var', 14: 'const', 22: 'enum-member', 23: 'struct', 24: 'event', 25: 'operator' };
const DEFAULT_LIMIT = 80;

const posKey = (uri, p) => `${uri}#${p.line}:${p.character}`;
const stripGenerics = s => { let prev; do { prev = s; s = s.replace(/<[^<>]*>/g, ''); } while (s !== prev); return s; };
// 정규화 이름 조각: 네임스페이스는 detail(전체 이름), 나머지는 제네릭·매개변수 제거
const nodeName = n => n.kind === 3 ? (n.detail || n.name) : stripGenerics(n.name.replace(/\(.*$/, ''));
const clip = s => { s = s.trim(); return s.length > 200 ? s.slice(0, 200) + '…' : s; };

// 루트 아래 소스 파일(isSrc) 전체 수집 (빌드·캐시 폴더 제외). proj 를 주면 프로젝트 파일(isProj) mtime 도 모은다
function scanFiles(root, isSrc, isProj, proj) {
  const out = new Map();
  (function walk(d) {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(p); }
      else if (isSrc(e.name)) { try { out.set(p, fs.statSync(p).mtimeMs); } catch {} }
      else if (proj && isProj(e.name)) { try { proj.set(p, fs.statSync(p).mtimeMs); } catch {} }
    }
  })(root);
  return out;
}

const isProjFile = n => /\.(csproj|sln)$/i.test(n);

function findSolution(root) {
  const slns = fs.readdirSync(root).filter(f => f.toLowerCase().endsWith('.sln'));
  if (slns.length === 1) return path.join(root, slns[0]);
  throw new Error(slns.length ? `솔루션이 여러 개다: ${slns.join(', ')} — solution 을 지정하라` : `${root} 에 .sln 이 없다`);
}

class Workspace {
  // onProjChange: csproj/sln mtime 이 바뀌면 호출 (재로드 판단은 Relay 가 한다)
  constructor(root, solution, log, onProjChange) {
    this.root = root;
    this.solution = solution;
    this.log = log;
    this.onProjChange = onProjChange || (() => {});
    this.disposed = false;
    this.busy = 0; // 진행 중인 질의 수
    this.fileCache = new Map(); // 경로 → { mtime, lines }
    this.symCache = new Map();  // uri → { mtime, symbols }
    this.syncChain = Promise.resolve();
    this.isSrc = n => n.endsWith('.cs');
    this.isProj = isProjFile;
    this.kindNames = KIND_NAMES;
  }

  _scan(proj) { return scanFiles(this.root, this.isSrc, this.isProj, proj); }

  start() {
    this.loaded = false;
    this.projMtimes = new Map();
    this.mtimes = this._scan(this.projMtimes);
    this._startWatch();
    const c = this.client = new LspClient(this.root, { name: 'csharp-ls', exe: CSHARP_EXE, args: ['--solution', this.solution] }, this.log);
    this.startedAt = Date.now();
    c.start();
    // csharp-ls 는 첫 요청이 와야 솔루션을 로드하고, 로딩이 끝날 때까지 그 요청을 붙잡는다 → 워밍업 요청 응답 = 로딩 완료
    this.readyP = c.initialize()
      .then(() => c.request('workspace/symbol', { query: '__lsp_relay_warmup__' }))
      .then(async () => {
        this.log(`솔루션 로딩 완료 (${((Date.now() - this.startedAt) / 1000).toFixed(1)}s)`);
        await this._warmQueries();
        this.loaded = true;
      });
    this.readyP.catch(e => this.log('로딩 실패: ' + e.message));
  }

  // 첫 질의가 느린 것(심볼 색인·컴파일 준비, 큰 Unity 솔루션 약 3초)을 로딩 단계에서 미리 치른다. 실패해도 무시
  async _warmQueries() {
    const t0 = Date.now();
    try {
      const res = (await this.client.request('workspace/symbol', { query: 'a' })) || [];
      const t = res.find(s => TYPE_KINDS.has(s.kind));
      if (t) {
        await this.client.request('textDocument/documentSymbol', { textDocument: { uri: t.location.uri } });
        await this.client.request('textDocument/references', { textDocument: { uri: t.location.uri }, position: t.location.range.start, context: { includeDeclaration: false } });
      }
      this.log(`예열 질의 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) { this.log('예열 질의 실패(무시): ' + e.message); }
  }

  _startWatch() {
    this.dirty = new Set();
    this.fullScan = false;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (ev, name) => {
        if (!name) { this.fullScan = true; return; }
        const segs = name.split(/[\\/]/);
        if (segs.slice(0, -1).some(s => SKIP_DIRS.has(s.toLowerCase()))) return;
        const base = segs[segs.length - 1];
        if (this.isSrc(base)) this.dirty.add(path.join(this.root, name));
        else if (this.isProj(base)) this._projEvent(path.join(this.root, name));
        else if (!base.includes('.')) this.fullScan = true; // 폴더 이동·삭제일 수 있음
      });
      this.watcher.on('error', e => { this.log('파일 감시 오류 → 매 질의 전체 스캔: ' + e.message); this.watcher = null; });
    } catch (e) {
      this.log('파일 감시 실패 → 매 질의 전체 스캔: ' + e.message);
      this.watcher = null;
    }
  }

  // csproj/sln 이벤트: Unity 는 여러 csproj 를 연달아 쓰므로 1.5초 모아서 mtime 비교
  _projEvent(p) {
    (this.projDirty ||= new Set()).add(p);
    clearTimeout(this.projTimer);
    this.projTimer = setTimeout(() => {
      const ps = [...this.projDirty];
      this.projDirty.clear();
      this._checkProj(ps);
    }, 1500);
  }

  _checkProj(paths) {
    if (this.disposed) return;
    const changed = [];
    for (const p of paths) {
      let m = null;
      try { m = fs.statSync(p).mtimeMs; } catch {}
      if (m !== (this.projMtimes.get(p) ?? null)) {
        if (m === null) this.projMtimes.delete(p); else this.projMtimes.set(p, m);
        changed.push(this.rel(p));
      }
    }
    if (changed.length) this.onProjChange(changed);
  }

  // 질의 직전: 바뀐 소스 파일을 언어 서버에 알린다. 바뀐 게 없으면 dirty 집합만 확인하고 끝.
  sync() {
    const run = async () => {
      const changes = [];
      const check = p => {
        let st = null;
        try { st = fs.statSync(p); } catch {}
        const old = this.mtimes.get(p);
        if (!st || !st.isFile()) {
          if (old !== undefined) { this.mtimes.delete(p); changes.push({ p, type: 3 }); }
        } else if (old === undefined) { this.mtimes.set(p, st.mtimeMs); changes.push({ p, type: 1 }); }
        else if (old !== st.mtimeMs) { this.mtimes.set(p, st.mtimeMs); changes.push({ p, type: 2 }); }
      };
      if (!this.watcher || this.fullScan) {
        this.fullScan = false;
        this.dirty.clear();
        const proj = new Map();
        const now = this._scan(proj);
        for (const p of new Set([...now.keys(), ...this.mtimes.keys()])) check(p);
        this._checkProj([...new Set([...proj.keys(), ...this.projMtimes.keys()])]);
      } else if (this.dirty.size) {
        const dirty = [...this.dirty];
        this.dirty.clear();
        dirty.forEach(check);
      }
      if (changes.length) {
        await this._applyChanges(changes);
        this.log(`변경 반영: ${changes.map(c => '+~-'[c.type - 1] + path.relative(this.root, c.p)).join(', ')}`);
      }
      return changes.length;
    };
    this.syncChain = this.syncChain.then(run, run);
    return this.syncChain;
  }

  // changes: [{ p, type(1 생성, 2 수정, 3 삭제) }]
  async _applyChanges(changes) {
    this.client.notify('workspace/didChangeWatchedFiles', { changes: changes.map(c => ({ uri: toUri(c.p), type: c.type })) });
  }

  // 질의 전 공통: 죽었으면 재시작, 로딩 대기, 변경 반영
  async ensure() {
    if (this.disposed) throw new Error(`프로젝트 ${this.client.name} 가 종료됐다 — 다시 질의하라`);
    if (!this.client.alive) { this.log(`${this.client.name} 재시작`); this.watcher?.close(); this.start(); }
    await this.readyP;
    await this.sync();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.projTimer);
    this.watcher?.close();
    await this.client.stop();
  }

  rel(p) {
    const r = path.relative(this.root, p);
    return (r.startsWith('..') || path.isAbsolute(r) ? p : r).replace(/\\/g, '/');
  }

  lines(p) {
    let st;
    try { st = fs.statSync(p); } catch { return []; }
    const c = this.fileCache.get(p);
    if (c && c.mtime === st.mtimeMs) return c.lines;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    this.fileCache.set(p, { mtime: st.mtimeMs, lines });
    return lines;
  }

  async docSymbols(uri) {
    const p = fromUri(uri);
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch {}
    const c = this.symCache.get(uri);
    if (c && c.mtime === mtime) return c.symbols;
    const symbols = (await this.client.request('textDocument/documentSymbol', { textDocument: { uri } })) || [];
    this.symCache.set(uri, { mtime, symbols });
    return symbols;
  }

  // 위치(selectionRange 시작)에 해당하는 문서 심볼과 조상 이름들
  async nodeAt(uri, pos) {
    const syms = await this.docSymbols(uri);
    let found = null;
    (function walk(nodes, chain) {
      for (const n of nodes) {
        const next = n.kind === 1 ? chain : [...chain, n];
        const s = (n.selectionRange || n.range).start;
        if (n.kind !== 1 && s.line === pos.line && s.character === pos.character) { found = next; return; }
        if (n.children) walk(n.children, next);
        if (found) return;
      }
    })(syms, []);
    return found;
  }

  // 'Type' / 'Ns.Type' / 'Type.Member' (+ '@경로일부') → { matches: [{qname, kind, uri, pos, detail}], ambiguous }
  async resolve(spec) {
    const at = spec.indexOf('@');
    const q = (at >= 0 ? spec.slice(0, at) : spec).trim();
    const pathPart = at >= 0 ? spec.slice(at + 1).trim().replace(/\\/g, '/').toLowerCase() : null;
    const parts = q.split('.');
    const endsWithQ = (qname, want) => qname === want || qname.endsWith('.' + want);

    const findTypes = async name => {
      const res = (await this.client.request('workspace/symbol', { query: name })) || [];
      const out = [];
      for (const s of res) {
        if (!(TYPE_KINDS.has(s.kind) || !/[ (]/.test(s.name))) continue;
        if (stripGenerics(s.name) !== name) continue;
        const pos = s.location.range.start;
        const chain = await this.nodeAt(s.location.uri, pos);
        const qname = chain ? chain.map(nodeName).join('.') : name;
        out.push({ qname, kind: s.kind, uri: s.location.uri, pos, node: chain && chain[chain.length - 1] });
      }
      return out;
    };

    let matches = (await findTypes(parts[parts.length - 1])).filter(c => endsWithQ(c.qname, q));
    if (!matches.length && parts.length >= 2) {
      // Type.Member: 타입을 찾고 그 파일의 문서 심볼에서 멤버를 고른다
      const member = parts[parts.length - 1];
      const typeQ = parts.slice(0, -1).join('.');
      const types = (await findTypes(parts[parts.length - 2])).filter(c => endsWithQ(c.qname, typeQ));
      for (const t of types) {
        for (const n of (t.node && t.node.children) || []) {
          if (stripGenerics(n.name.replace(/\(.*$/, '')) !== member) continue;
          matches.push({ qname: `${t.qname}.${member}`, kind: n.kind, uri: t.uri, pos: n.selectionRange.start, detail: n.detail });
        }
      }
    }
    if (!matches.length && parts.length === 1) {
      // 타입이 아니면 멤버 이름으로 찾는다 (예: 'Greet')
      const res = (await this.client.request('workspace/symbol', { query: q })) || [];
      for (const s of res) {
        if (TYPE_KINDS.has(s.kind)) continue;
        const head = stripGenerics(s.name.replace(/\(.*$/, ''));
        const qual = head.slice(head.lastIndexOf(' ') + 1); // 'Type.Member'
        if (qual.split('.').pop() !== q) continue;
        const pos = s.location.range.start;
        const chain = await this.nodeAt(s.location.uri, pos);
        const qname = chain ? chain.map(nodeName).join('.') : qual;
        matches.push({ qname, kind: s.kind, uri: s.location.uri, pos, detail: chain && chain[chain.length - 1].detail });
      }
    }
    if (pathPart) matches = matches.filter(m => this.rel(fromUri(m.uri) || m.uri).toLowerCase().includes(pathPart));
    // 같은 위치 중복 제거 (여러 프로젝트에 같은 파일이 들어간 경우)
    const seen = new Set();
    matches = matches.filter(m => { const k = posKey(m.uri, m.pos); if (seen.has(k)) return false; seen.add(k); return true; });
    const qnames = new Set(matches.map(m => m.qname));
    return { matches, ambiguous: qnames.size > 1 };
  }

  defLine(m) {
    const p = fromUri(m.uri);
    const where = `${this.rel(p)}:${m.pos.line + 1}`;
    const sig = m.detail && !TYPE_KINDS.has(m.kind) ? m.detail : clip(this.lines(p)[m.pos.line] || '');
    return `${where} | ${sig}`;
  }

  candidatesText(spec, matches) {
    const out = [`${spec}: 후보 ${new Set(matches.map(m => m.qname)).size}개 — 네임스페이스를 붙이거나 '${spec.split('@')[0]}@경로일부' 로 좁혀라`];
    for (const m of matches) out.push(`  ${m.qname} (${this.kindNames[m.kind] || m.kind}) ${this.defLine(m)}`);
    return out.join('\n');
  }

  async refsOne(spec, { context_lines = 0, path_filter, limit = DEFAULT_LIMIT }) {
    const { matches, ambiguous } = await this.resolve(spec);
    if (!matches.length) return `${spec}: 찾지 못함`;
    if (ambiguous) return this.candidatesText(spec, matches);
    // 부분 클래스는 위치 하나로 충분, 멤버 오버로드는 합친다
    const targets = TYPE_KINDS.has(matches[0].kind) ? [matches[0]] : matches;
    const all = [];
    const seen = new Set();
    for (const t of targets) {
      const locs = await this.refLocs(t);
      for (const l of locs) {
        const k = posKey(l.uri, l.range.start);
        if (!seen.has(k)) { seen.add(k); all.push(l); }
      }
    }
    const byFile = new Map();
    for (const l of all) {
      const p = fromUri(l.uri) || l.uri;
      const r = this.rel(p);
      if (!byFile.has(r)) byFile.set(r, { p, lines: [] });
      byFile.get(r).lines.push(l.range.start.line);
    }
    const totalFiles = byFile.size;
    let files = [...byFile.entries()];
    let head = `${matches[0].qname}: ${all.length} refs / ${totalFiles} files`;
    if (path_filter) {
      const f = filterFn(path_filter);
      files = files.filter(([r]) => f(r));
      const n = files.reduce((a, [, v]) => a + v.lines.length, 0);
      head += ` (필터 '${path_filter}': ${n} refs / ${files.length} files)`;
    }
    files.sort((a, b) => a[0].localeCompare(b[0]));
    const out = [head, `  정의 ${matches.length > 1 && targets.length > 1 ? `(오버로드 ${targets.length}개 합산) ` : ''}${this.defLine(matches[0])}`];
    let shown = 0, restRefs = 0, restFiles = 0;
    for (const [r, v] of files) {
      if (shown >= limit) { restRefs += v.lines.length; restFiles++; continue; }
      const text = this.lines(v.p);
      const hits = [...new Set(v.lines)].sort((a, b) => a - b);
      out.push(r);
      if (!context_lines) {
        for (const ln of hits) {
          if (shown >= limit) { restRefs += v.lines.filter(x => x === ln).length; continue; }
          out.push(`  ${ln + 1} | ${clip(text[ln] || '')}`);
          shown++;
        }
      } else {
        const hitSet = new Set(hits);
        let last = -2;
        for (const ln of hits) {
          if (shown >= limit) { restRefs++; continue; }
          const from = Math.max(0, ln - context_lines, last + 1);
          const to = Math.min(text.length - 1, ln + context_lines);
          if (last >= 0 && from > last + 1) out.push('  --');
          for (let i = from; i <= to; i++) out.push(`  ${i + 1} ${hitSet.has(i) ? '|' : '-'} ${clip(text[i] || '')}`);
          last = to;
          shown++;
        }
      }
    }
    if (restRefs || restFiles) out.push(`… 외 ${restRefs}개 refs${restFiles ? ` (${restFiles} files 더)` : ''} — path_filter 나 limit 로 좁혀라`);
    return out.join('\n');
  }

  async refLocs(t) {
    return (await this.client.request('textDocument/references', {
      textDocument: { uri: t.uri }, position: t.pos, context: { includeDeclaration: false },
    })) || [];
  }

  async defsOne(spec) {
    const { matches, ambiguous } = await this.resolve(spec);
    if (!matches.length) return `${spec}: 찾지 못함`;
    if (ambiguous) return this.candidatesText(spec, matches);
    const out = [`${matches[0].qname} (${this.kindNames[matches[0].kind] || matches[0].kind})`];
    for (const m of matches) out.push(`  ${this.defLine(m)}`);
    return out.join('\n');
  }

  async outlineOne(file) {
    const p = path.resolve(this.root, file);
    if (!fs.existsSync(p)) return `${file}: 파일 없음`;
    const syms = await this.docSymbols(toUri(p));
    const out = [this.rel(p)];
    (function walk(nodes, depth) {
      for (const n of nodes) {
        if (n.kind === 1 || n.kind === 3) { walk(n.children || [], depth); continue; } // 파일·네임스페이스는 건너뜀
        const line = (n.selectionRange || n.range).start.line + 1;
        let type = '';
        if (n.detail && !TYPE_KINDS.has(n.kind)) {
          const head = n.detail.replace(/\(.*$/, '');
          const sp = head.lastIndexOf(' ');
          if (sp > 0 && n.kind !== 9) type = ' : ' + head.slice(0, sp);
        }
        out.push(`${'  '.repeat(depth + 1)}${line} ${KIND_NAMES[n.kind] || n.kind} ${n.name}${type}`);
        if (n.children) walk(n.children, depth + 1);
      }
    })(syms, 0);
    if (out.length === 1) out.push('  (심볼 없음 — 솔루션에 포함되지 않은 파일일 수 있다)');
    return out.join('\n');
  }
}

// Luau(Rojo) 워크스페이스: luau-lsp 1개. sourcemap 은 데몬이 rojo 로 임시 폴더에 만들고, 파일 추가·삭제·*.project.json 변경 때 다시 만든다.
// luau-lsp 는 연(didOpen) 문서에만 documentSymbol/references 를 답하므로 필요한 파일을 그때그때 연다.
const LUAU_KINDS = { 2: 'module', 6: 'method', 11: 'type', 12: 'function', 13: 'var', 14: 'const' };
const ROJO_EXE = path.join(os.homedir(), '.rokit', 'bin', process.platform === 'win32' ? 'rojo.exe' : 'rojo');
const ROJO_PROJECT = 'default.project.json';
const DEFINITIONS = 'tools/types/globalTypes.d.luau';

// luau-lsp 가 쓰는 URI 형식(드라이브 소문자 + %3A)에 맞춰야 연 문서와 응답 URI 가 같아진다
const luauUri = p => 'file:///' + path.resolve(p).split(path.sep).map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, (_, d) => d.toLowerCase() + '%3A');
// 모듈 이름: 파일 이름에서 .server/.client 와 확장자를 뗀 것, init 이면 폴더 이름 (Rojo 규칙)
const modPath = rel => {
  const segs = rel.replace(/\.(server|client)?\.?luau?$/i, '').split('/');
  if (segs.length > 1 && segs[segs.length - 1] === 'init') segs.pop();
  return segs;
};

class LuauWorkspace extends Workspace {
  constructor(root, log) {
    super(root, null, log);
    this.isSrc = n => /\.luau?$/i.test(n);
    this.isProj = n => /\.project\.json$/i.test(n);
    this.kindNames = LUAU_KINDS;
    this.onProjChange = () => { this.sourcemapDirty = true; };
    this.tmpDir = path.join(os.tmpdir(), 'lsp-relay', `${path.basename(root)}-${crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 8)}`);
    this.sourcemap = path.join(this.tmpDir, 'sourcemap.json');
  }

  start() {
    this.loaded = false;
    this.opened = new Map(); // uri → version
    this.projMtimes = new Map();
    this.mtimes = this._scan(this.projMtimes);
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this._genSourcemap();
    this._startWatch();
    const settings = { 'luau-lsp': { sourcemap: { enabled: true, autogenerate: false, sourcemapFile: this.sourcemap }, index: { enabled: true } } };
    const args = ['lsp'];
    const defs = path.join(this.root, DEFINITIONS);
    if (fs.existsSync(defs)) args.push(`--definitions=@roblox=${defs}`);
    else this.log(`정의 파일 없음(${DEFINITIONS}) — Roblox 타입 없이 띄운다`);
    const c = this.client = new LspClient(this.root, { name: 'luau-lsp', exe: LUAU_EXE, args, settings }, this.log);
    this.startedAt = Date.now();
    c.on('notification', m => { if (m.method === 'window/logMessage' && m.params.type === 1) this.log('[luau-lsp] ' + m.params.message); });
    c.start();
    // luau-lsp 는 첫 문서 요청이 와야 정의 파일 로드(약 5초)·색인을 한다 → 파일 하나의 documentSymbol 응답 = 로딩 완료
    const first = [...this.mtimes.keys()][0];
    this.readyP = c.initialize().then(() => first && this.docSymbols(luauUri(first))).then(() => {
      this.log(`luau-lsp 로딩 완료 (${((Date.now() - this.startedAt) / 1000).toFixed(1)}s, 소스 ${this.mtimes.size}개)`);
      this.loaded = true;
    });
    this.readyP.catch(e => this.log('로딩 실패: ' + e.message));
  }

  // 프로젝트 폴더에는 쓰지 않는다 (임시 폴더의 sourcemap.json)
  _genSourcemap() {
    this.sourcemapDirty = false;
    try {
      execFileSync(ROJO_EXE, ['sourcemap', ROJO_PROJECT, '-o', this.sourcemap], { cwd: this.root, windowsHide: true, stdio: 'pipe' });
    } catch (e) {
      throw new Error('rojo sourcemap 실패: ' + String(e.stderr || e.message).trim().split('\n')[0]);
    }
  }

  async _applyChanges(changes) {
    const c = this.client;
    c.notify('workspace/didChangeWatchedFiles', { changes: changes.map(x => ({ uri: luauUri(x.p), type: x.type })) });
    // 연 문서는 디스크를 다시 읽지 않으므로 전체 내용으로 갱신(삭제면 닫는다)
    for (const x of changes) {
      const uri = luauUri(x.p);
      if (!this.opened.has(uri)) continue;
      if (x.type === 3) { c.notify('textDocument/didClose', { textDocument: { uri } }); this.opened.delete(uri); continue; }
      const version = this.opened.get(uri) + 1;
      this.opened.set(uri, version);
      c.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: fs.readFileSync(x.p, 'utf8') }] });
    }
    if (changes.some(x => x.type !== 2)) this.sourcemapDirty = true;
  }

  async sync() {
    await super.sync();
    // 파일 추가·삭제·프로젝트 파일 변경 → sourcemap 재생성 후 설정 변경 알림(luau-lsp 가 이때 sourcemap 을 다시 읽는다)
    if (this.sourcemapDirty) {
      this.syncChain = this.syncChain.then(async () => {
        if (!this.sourcemapDirty) return;
        try { this._genSourcemap(); } catch (e) { this.log(e.message); return; }
        const reread = new Promise(res => { const t = setTimeout(res, 3000); this.client.once('configuration', () => { clearTimeout(t); res(); }); });
        this.client.notify('workspace/didChangeConfiguration', { settings: this.client.cmd.settings });
        await reread;
        this.log('sourcemap 재생성');
      });
      await this.syncChain;
    }
  }

  open(uri) {
    if (this.opened.has(uri)) return;
    const p = fromUri(uri);
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
    this.opened.set(uri, 1);
    this.client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text } });
  }

  async docSymbols(uri) {
    this.open(uri);
    return super.docSymbols(uri);
  }

  // 모듈 목록: { p, uri, segs(경로 조각, 마지막이 모듈 이름), name }
  modules() {
    return [...this.mtimes.keys()].map(p => {
      const segs = modPath(this.rel(p));
      return { p, uri: luauUri(p), segs, name: segs[segs.length - 1] };
    });
  }

  // 모듈 파일 끝의 'return 이름' (모듈 테이블 변수)
  retIdent(p) {
    const lines = this.lines(p);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^\s*return\s+([A-Za-z_]\w*)\s*$/.exec(lines[i]);
      if (m) return m[1];
      if (/^\s*return\b/.test(lines[i])) return null;
    }
    return null;
  }

  // 심볼의 마지막 이름 조각 위치 ('Util.add' 면 add 쪽) — references 는 이 위치로 물어야 멤버 참조가 나온다
  static lastSegPos(n) {
    const r = n.selectionRange || n.range;
    const last = n.name.split(/[.:]/).pop();
    return r.start.line === r.end.line ? { line: r.end.line, character: Math.max(r.start.character, r.end.character - last.length) } : r.start;
  }

  // 모듈 하나에서 member('' 면 모듈 자체) 찾기
  async findInModule(mod, member) {
    const ret = this.retIdent(mod.p);
    const syms = await this.docSymbols(mod.uri);
    if (!member) {
      const n = ret && syms.find(s => s.name === ret);
      if (n) return [{ qname: mod.name, kind: 2, uri: mod.uri, pos: (n.selectionRange || n.range).start }];
      return [{ qname: mod.name, kind: 2, uri: mod.uri, pos: { line: 0, character: 0 }, requireScan: true }];
    }
    const out = [];
    for (const n of syms) {
      const name = n.name.replace(/:/g, '.');
      let qname = null;
      if (ret && name === `${ret}.${member}`) qname = mod.name + n.name.slice(ret.length);
      else if (name === member) qname = `${mod.name}.${n.name}`;
      if (qname) out.push({ qname, kind: n.kind, uri: mod.uri, pos: LuauWorkspace.lastSegPos(n) });
    }
    return out;
  }

  // 'Module' / 'Module.member' / '경로.Module.member' / '파일.luau:member' / 'member' (+ '@경로일부')
  async resolve(spec) {
    const at = spec.indexOf('@');
    let q = (at >= 0 ? spec.slice(0, at) : spec).trim();
    const pathPart = at >= 0 ? spec.slice(at + 1).trim().replace(/\\/g, '/').toLowerCase() : null;
    const mods = this.modules();
    let matches = [];

    const fm = /^(.+\.luau?):(.*)$/i.exec(q);
    if (fm) {
      const p = path.resolve(this.root, fm[1]);
      const mod = mods.find(m => samePath(m.p, p));
      if (!mod) return { matches: [], ambiguous: false };
      matches = await this.findInModule(mod, fm[2].replace(/:/g, '.'));
    } else {
      const parts = q.replace(/:/g, '.').split('.');
      // 앞쪽을 모듈 경로로 최대한 길게 맞춰 본다: shared.Util.add → 모듈 [shared, Util] + add
      for (let k = parts.length; k >= 1 && !matches.length; k--) {
        const want = parts.slice(0, k);
        const hit = mods.filter(m => m.segs.length >= k && want.every((w, i) => m.segs[m.segs.length - k + i] === w));
        for (const mod of hit) matches.push(...await this.findInModule(mod, parts.slice(k).join('.')));
      }
      if (!matches.length) {
        // 모듈 이름이 아니면 workspace/symbol 로 이름 검색 (예: 'helper', 'Point')
        const res = (await this.client.request('workspace/symbol', { query: parts[parts.length - 1] })) || [];
        for (const s of res) {
          const name = s.name.replace(/:/g, '.');
          if (name !== q.replace(/:/g, '.') && !name.endsWith('.' + q.replace(/:/g, '.'))) continue;
          const p = fromUri(s.location.uri);
          const mod = mods.find(m => samePath(m.p, p));
          const n = (await this.docSymbols(luauUri(p))).find(x => x.name === s.name && (x.selectionRange || x.range).start.line === s.location.range.start.line);
          if (!mod || !n) continue;
          const ret = this.retIdent(p);
          const qname = ret && (name === ret || name.startsWith(ret + '.')) ? mod.name + s.name.slice(ret.length) : `${mod.name}.${s.name}`;
          matches.push({ qname, kind: s.kind, uri: luauUri(p), pos: LuauWorkspace.lastSegPos(n) });
        }
      }
    }
    if (pathPart) matches = matches.filter(m => this.rel(fromUri(m.uri)).toLowerCase().includes(pathPart));
    const seen = new Set();
    matches = matches.filter(m => { const k = posKey(m.uri, m.pos); if (seen.has(k)) return false; seen.add(k); return true; });
    // 같은 이름의 다른 위치(다른 파일)는 후보로 보여 준다
    const where = new Set(matches.map(m => `${m.qname}@${m.uri}`));
    return { matches, ambiguous: where.size > 1 };
  }

  defLine(m) {
    const p = fromUri(m.uri);
    return `${this.rel(p)}:${m.pos.line + 1} | ${clip(this.lines(p)[m.pos.line] || '')}`;
  }

  candidatesText(spec, matches) {
    const out = [`${spec}: 후보 ${matches.length}개 — 모듈 경로를 붙이거나(shared.Util.add) '${spec.split('@')[0]}@경로일부' / '파일.luau:이름' 으로 좁혀라`];
    for (const m of matches) out.push(`  ${m.qname} (${this.kindNames[m.kind] || m.kind}) ${this.defLine(m)}`);
    return out.join('\n');
  }

  async refLocs(t) {
    if (!t.requireScan) {
      this.open(t.uri);
      // luau-lsp 는 includeDeclaration: false 여도 선언(모듈이면 초기값 {} 도)을 넣어 준다 → 정의 줄은 뺀다
      return (await super.refLocs(t)).filter(l => !(l.uri === t.uri && l.range.start.line === t.pos.line));
    }
    // 'return function() …' 처럼 모듈 변수가 없으면: require( 줄에서 모듈 이름 위치의 정의가 이 파일인지 확인
    const name = t.qname;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const target = fromUri(t.uri);
    const out = [];
    for (const p of this.mtimes.keys()) {
      if (samePath(p, target)) continue;
      const lines = this.lines(p);
      const uri = luauUri(p);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('require')) continue;
        for (const m of lines[i].matchAll(re)) {
          this.open(uri);
          const defs = (await this.client.request('textDocument/definition', { textDocument: { uri }, position: { line: i, character: m.index } })) || [];
          if ([].concat(defs).some(d => samePath(fromUri(d.uri || d.targetUri), target))) out.push({ uri, range: { start: { line: i, character: m.index } } });
        }
      }
    }
    return out;
  }

  async outlineOne(file) {
    const p = path.resolve(this.root, file);
    if (!fs.existsSync(p)) return `${file}: 파일 없음`;
    const syms = await this.docSymbols(luauUri(p));
    const out = [this.rel(p)];
    for (const n of syms) {
      const line = (n.selectionRange || n.range).start.line + 1;
      const sig = n.detail && /^function\s*\(/.test(n.detail) ? n.detail.replace(/^function\s*/, '') : '';
      out.push(`  ${line} ${this.kindNames[n.kind] || n.kind} ${n.name}${sig}`);
    }
    if (out.length === 1) out.push('  (최상위 심볼 없음)');
    return out.join('\n');
  }
}

// path_filter: '*' 가 있으면 글롭, 없으면 부분 문자열 (대소문자 무시)
function filterFn(pat) {
  const p = pat.replace(/\\/g, '/').toLowerCase();
  if (!p.includes('*')) return r => r.toLowerCase().includes(p);
  const re = new RegExp('^' + p.split(/(\*\*\/?|\*)/).map(t => t === '**/' || t === '**' ? '.*' : t === '*' ? '[^/]*' : t.replace(/[.+?^${}()|[\]]/g, '\\$&')).join('') + '$');
  return r => re.test(r.toLowerCase());
}

const samePath = (a, b) => {
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const slash = p => p.replace(/\\/g, '/');

// 프로젝트 = projects.json 의 이름 → { root, lang, solution, pinned }. 실행 중인 것만 state 에 있다.
class Relay {
  constructor(log, configFile) {
    this.log = log;
    this.configFile = configFile;
    this.base = path.dirname(configFile);
    this.cfg = null;
    this.cfgMtime = null;
    this.state = new Map(); // 이름 → { name, root, solution, ws, next(재로드 중인 새 ws), reason, reloadAgain, lastUsed }
    this._loadConfig();
    this.timer = setInterval(() => this._idleCheck(), 10000);
    this.timer.unref();
  }

  // projects.json 은 mtime 이 바뀌었을 때만 다시 읽는다 (손으로 고쳐도 다음 질의부터 반영)
  _loadConfig() {
    let mtime = 0;
    try { mtime = fs.statSync(this.configFile).mtimeMs; } catch {}
    if (this.cfg && mtime === this.cfgMtime) return this.cfg;
    this.cfgMtime = mtime;
    let raw = {};
    if (mtime) {
      try { raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8')); } catch (e) {
        this.log(`projects.json 읽기 실패 — 이전 설정 유지: ${e.message}`);
        if (this.cfg) return this.cfg;
      }
    }
    const projects = new Map();
    for (const [name, p] of Object.entries(raw.projects || {})) {
      const root = path.resolve(this.base, p.root);
      const lang = p.lang === 'luau' ? 'luau' : 'csharp';
      projects.set(name, { name, root, lang, solution: lang === 'csharp' && p.solution ? path.resolve(root, p.solution) : null, pinned: !!p.pinned });
    }
    this.cfg = {
      raw, projects,
      default: raw.default && projects.has(raw.default) ? raw.default : [...projects.keys()][0] || null,
      idleMin: raw.idle_minutes ?? 30,
      maxRunning: raw.max_running ?? 2,
    };
    // 설정에서 빠졌거나 root 가 바뀐 실행 중 프로젝트는 내린다
    for (const st of [...this.state.values()]) {
      const p = projects.get(st.name);
      if (!p || !samePath(p.root, st.root)) this._stop(st, '설정에서 제거·변경됨');
    }
    return this.cfg;
  }

  _saveConfig(raw) {
    fs.writeFileSync(this.configFile, JSON.stringify(raw, null, 2) + '\n');
    this._loadConfig();
  }

  _pinned(name) { return !!this.cfg.projects.get(name)?.pinned; }

  // project 인자: 이름(대소문자 무시) 또는 root 경로. 생략하면 기본 프로젝트
  _project(spec) {
    const cfg = this._loadConfig();
    if (!cfg.projects.size) throw new Error('등록된 프로젝트가 없다 — workspace(root) 로 추가하라');
    if (!spec) return cfg.projects.get(cfg.default);
    const list = [...cfg.projects.values()];
    const p = list.find(x => x.name.toLowerCase() === String(spec).toLowerCase()) || list.find(x => samePath(x.root, String(spec)));
    if (!p) throw new Error(`없는 프로젝트: ${spec} — 등록된 프로젝트: ${[...cfg.projects.keys()].join(', ')}. 새 프로젝트는 workspace(root) 로 추가하라`);
    return p;
  }

  _newWs(st) {
    const log = msg => this.log(`[${st.name}] ${msg}`);
    const ws = st.lang === 'luau' ? new LuauWorkspace(st.root, log) : new Workspace(st.root, st.solution, log, changed => this._reload(st, ws, changed));
    ws.start();
    return ws;
  }

  _start(p) {
    if (!fs.existsSync(p.root)) throw new Error(`폴더 없음: ${p.root}`);
    let solution = null;
    if (p.lang === 'luau') {
      if (!fs.existsSync(path.join(p.root, ROJO_PROJECT))) throw new Error(`${ROJO_PROJECT} 없음: ${p.root}`);
    } else {
      solution = p.solution || findSolution(p.root);
      if (!fs.existsSync(solution)) throw new Error(`솔루션 없음: ${solution}`);
    }
    this._makeRoom(p.name);
    const st = { name: p.name, root: p.root, lang: p.lang, solution, next: null, lastUsed: Date.now() };
    st.ws = this._newWs(st);
    this.state.set(p.name, st);
    this.log(`[${p.name}] 시작: ${p.root} / ${solution ? path.basename(solution) : ROJO_PROJECT} (${st.ws.client.name} pid ${st.ws.client.proc.pid})`);
    return st;
  }

  // 동시 실행 상한: 새로 띄우기 전에 가장 오래 안 쓴 비고정(질의 중 아님) 프로젝트부터 내린다
  _makeRoom(except) {
    const max = this.cfg.maxRunning;
    const running = [...this.state.values()].filter(s => s.name !== except);
    let over = running.length - max + 1;
    if (over <= 0) return;
    const victims = running.filter(s => !this._pinned(s.name) && !s.ws.busy).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const v of victims) {
      if (over <= 0) break;
      this._stop(v, `동시 실행 상한 ${max} — 가장 오래 안 쓴 프로젝트`);
      over--;
    }
    if (over > 0) this.log(`동시 실행 상한 ${max} 을 넘겨 띄운다 (내릴 수 있는 비고정 프로젝트 없음)`);
  }

  // 질의 중인 ws 는 질의가 끝난 뒤 종료
  _retire(ws) {
    ws.retired = true;
    if (!ws.busy) ws.dispose().catch(() => {});
  }

  _stop(st, why) {
    if (this.state.get(st.name) === st) this.state.delete(st.name);
    this.log(`[${st.name}] 종료: ${why}`);
    if (st.next) { st.next.dispose().catch(() => {}); st.next = null; }
    this._retire(st.ws);
  }

  _idleCheck() {
    this._loadConfig();
    const idleMs = this.cfg.idleMin * 60000;
    for (const st of [...this.state.values()]) {
      if (this._pinned(st.name) || st.ws.busy || st.next) continue;
      if (Date.now() - st.lastUsed >= idleMs) this._stop(st, `${this.cfg.idleMin}분 동안 질의 없음`);
    }
  }

  // csproj/sln 변경(csharp 만): 새 csharp-ls 를 백그라운드로 로드하고, 끝나면 교체. 그 전까지는 기존 서버가 답한다
  _reload(st, ws, changed) {
    if (this.state.get(st.name) !== st || ws !== st.ws) return; // 현재 서버의 감시만 따른다
    if (st.next) { st.reloadAgain = changed; this.log(`[${st.name}] 재로드 중 추가 변경(${changed.join(', ')}) → 끝나면 한 번 더`); return; }
    st.reason = `${changed.join(', ')} 변경`;
    this.log(`[${st.name}] ${st.reason} → 백그라운드 재로드`);
    const next = st.next = this._newWs(st);
    next.readyP.then(() => {
      if (this.state.get(st.name) !== st || st.next !== next) return next.dispose();
      const old = st.ws;
      st.ws = next;
      st.next = null;
      this.log(`[${st.name}] 재로드 완료 → 새 csharp-ls(pid ${next.client.proc.pid}) 로 교체`);
      this._retire(old);
      if (st.reloadAgain) { const c = st.reloadAgain; st.reloadAgain = null; this._reload(st, next, c); }
    }, e => {
      this.log(`[${st.name}] 재로드 실패 — 기존 서버 유지: ${e.message}`);
      if (st.next === next) st.next = null;
      next.dispose().catch(() => {});
    });
  }

  // 질의 공통: 프로젝트를 고르고(없으면 띄우고) 사용 시각을 남긴다
  async _use(project, fn) {
    const p = this._project(project);
    const st = this.state.get(p.name) || this._start(p);
    st.lastUsed = Date.now();
    const ws = st.ws;
    const reloading = !!st.next;
    ws.busy++;
    try {
      await ws.ensure();
      const text = await fn(ws);
      return reloading ? `(재로드 중: ${st.reason} — 기존 csharp-ls 로 응답)\n${text}` : text;
    } finally {
      ws.busy--;
      st.lastUsed = Date.now();
      if (ws.retired && !ws.busy) ws.dispose().catch(() => {});
    }
  }

  // 데몬 시작 시 고정 프로젝트를 미리 로드
  preloadPinned() {
    for (const p of this._loadConfig().projects.values()) {
      if (!p.pinned || this.state.has(p.name)) continue;
      try { this._start(p); } catch (e) { this.log(`[${p.name}] 미리 로드 실패: ${e.message}`); }
    }
  }

  // root 가 있으면 프로젝트 추가(로드는 첫 질의 때), 없으면 목록. 기본 프로젝트는 바꾸지 않는다(다른 세션 영향 없음)
  async workspace({ root, name, solution, pinned, lang }) {
    if (!root) return this.list();
    root = path.resolve(root);
    if (!fs.existsSync(root)) throw new Error(`폴더 없음: ${root}`);
    const luau = lang === 'luau';
    if (lang && !['luau', 'csharp'].includes(lang)) throw new Error(`lang 은 csharp 또는 luau: ${lang}`);
    if (luau) {
      if (!fs.existsSync(path.join(root, ROJO_PROJECT))) throw new Error(`${ROJO_PROJECT} 없음: ${root}`);
    } else {
      solution = solution ? path.resolve(root, solution) : findSolution(root);
      if (!fs.existsSync(solution)) throw new Error(`솔루션 없음: ${solution}`);
    }
    const cfg = this._loadConfig();
    const byRoot = [...cfg.projects.values()].find(p => samePath(p.root, root));
    name = name || byRoot?.name || path.basename(root);
    const same = cfg.projects.get(name);
    if (same && !samePath(same.root, root)) throw new Error(`이름 '${name}' 은 이미 ${slash(same.root)} 에 쓰였다 — name 을 따로 줘라`);
    if (byRoot && byRoot.name !== name) throw new Error(`이미 '${byRoot.name}' 으로 등록된 폴더다`);
    const raw = { ...cfg.raw, projects: { ...(cfg.raw.projects || {}) } };
    const relSln = luau ? null : path.relative(root, solution);
    raw.projects[name] = {
      ...(raw.projects[name] || { root: slash(root) }),
      ...(luau ? { lang: 'luau' } : { solution: slash(relSln.startsWith('..') ? solution : relSln) }),
      ...(pinned !== undefined ? { pinned: !!pinned } : {}),
    };
    if (!luau) delete raw.projects[name].lang;
    if (!raw.default) raw.default = name;
    this._saveConfig(raw);
    const running = this.state.get(name);
    if (running && (running.lang !== (luau ? 'luau' : 'csharp') || (!luau && !samePath(running.solution, solution)))) this._stop(running, '솔루션·언어 변경 — 다음 질의 때 다시 로드');
    return `${same ? '프로젝트 갱신' : '프로젝트 추가'}: ${name} → ${slash(root)} / ${luau ? ROJO_PROJECT + ' (luau)' : path.basename(solution)} — 첫 질의 때 로드한다 (project: "${name}")\n\n${this.list()}`;
  }

  list() {
    const cfg = this._loadConfig();
    const out = [`기본 프로젝트: ${cfg.default || '(없음)'} | 비고정은 ${cfg.idleMin}분 idle 후 종료 | 동시 실행 상한 ${cfg.maxRunning}`];
    for (const p of cfg.projects.values()) {
      const st = this.state.get(p.name);
      let state = '중지';
      if (st) {
        state = st.ws.loaded ? `실행 중 pid ${st.ws.client.proc.pid}` : '로딩 중';
        if (st.next) state += ` · 재로드 중(${st.reason})`;
        state += ` · 마지막 사용 ${Math.round((Date.now() - st.lastUsed) / 60000)}분 전`;
      }
      const sln = p.lang === 'luau' ? ROJO_PROJECT : p.solution ? path.basename(p.solution) : '(유일한 .sln)';
      out.push(`${p.name === cfg.default ? '*' : ' '} ${p.name} [${p.lang}]${p.pinned ? ' [고정]' : ''} — ${state} — ${slash(p.root)} / ${sln}`);
    }
    if (!cfg.projects.size) out.push('  (등록된 프로젝트 없음 — workspace(root) 로 추가)');
    return out.join('\n');
  }

  async refs({ project, symbols, context_lines, path_filter, limit }) {
    return this._use(project, async ws => (await Promise.all(asList(symbols).map(s => ws.refsOne(s, { context_lines: +context_lines || 0, path_filter, limit: +limit || DEFAULT_LIMIT }).catch(e => `${s}: 오류 — ${e.message}`)))).join('\n\n'));
  }

  async defs({ project, symbols }) {
    return this._use(project, async ws => (await Promise.all(asList(symbols).map(s => ws.defsOne(s).catch(e => `${s}: 오류 — ${e.message}`)))).join('\n\n'));
  }

  async outline({ project, files }) {
    return this._use(project, async ws => (await Promise.all(asList(files).map(f => ws.outlineOne(f).catch(e => `${f}: 오류 — ${e.message}`)))).join('\n\n'));
  }

  status() {
    const cfg = this._loadConfig();
    return {
      default: cfg.default, idle_minutes: cfg.idleMin, max_running: cfg.maxRunning,
      projects: [...cfg.projects.values()].map(p => {
        const st = this.state.get(p.name);
        return {
          name: p.name, root: p.root, lang: p.lang, pinned: p.pinned, running: !!st, loaded: !!st?.ws.loaded,
          reloading: !!st?.next, lspPid: st?.ws.client.alive ? st.ws.client.proc.pid : null,
          idleSec: st ? Math.round((Date.now() - st.lastUsed) / 1000) : null,
        };
      }),
    };
  }

  async shutdown() {
    clearInterval(this.timer);
    await Promise.all([...this.state.values()].flatMap(st => [st.ws.dispose(), st.next?.dispose()]).filter(Boolean));
    this.state.clear();
  }
}

const asList = v => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);

module.exports = { Relay };
