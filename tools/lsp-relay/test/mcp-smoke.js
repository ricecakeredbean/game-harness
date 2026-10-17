// MCP 클라이언트 2개를 동시에 붙여 도구 목록·refs 를 호출하는 스모크 테스트 (환경변수 LSP_PROJECT 로 프로젝트 지정)
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

async function session(name, symbols) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7420/mcp')));
  const tools = (await client.listTools()).tools.map(t => t.name);
  const t0 = Date.now();
  const r = await client.callTool({ name: 'refs', arguments: { project: process.env.LSP_PROJECT, symbols, limit: 3 } });
  const head = r.content[0].text.split('\n').filter(l => / refs \/ /.test(l));
  await client.close();
  return `${name}: tools=[${tools}] ${Date.now() - t0}ms\n  ${head.join('\n  ')}`;
}

(async () => {
  const args = process.argv.slice(2);
  const res = await Promise.all([session('mcp-A', args.length ? args : ['Fixture.Greeter']), session('mcp-B', args.length ? args : ['Greeter'])]);
  console.log(res.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
