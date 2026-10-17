# lsp-relay

언어 서버(C# 는 csharp-ls, Roblox Luau 는 luau-lsp)를 **프로젝트마다 하나씩만** 상주시키고, 여러 Claude 세션·스크립트가 grep 대신 심볼 정의/참조를 한 번에 질의하게 해 주는 중계 데몬이다. 데몬은 하나이고, 결과는 심볼별·파일별로 묶은 짧은 텍스트로 나온다.

```
Claude 세션 A ─┐                                          ┌─ csharp-ls (MyUnityGame, 고정)
Claude 세션 B ─┼─ HTTP 127.0.0.1:7420 ── server.js ───────┼─ luau-lsp (MyRobloxGame)
cli.js / 스크립트 ┘     /mcp, /api/<tool>   projects.json    └─ …(동시 실행 상한까지)
```

## 준비

- Node.js 24, csharp-ls 0.28.0 (`%USERPROFILE%\.dotnet\tools\csharp-ls.exe`), .NET SDK
- Luau 프로젝트용: luau-lsp 1.70.1 · rojo (`%USERPROFILE%\.rokit\bin\`, Rokit 설치)
- 이 폴더에서 `npm install` (의존성은 이 폴더 안에만 설치된다. 플러그인을 업데이트하면 다시 해야 한다 — `/game-harness:harness-setup` 이 확인한다)

## 실행

```bash
# 백그라운드 시작 (이미 떠 있으면 그대로 둔다). 고정 프로젝트를 바로 미리 로드한다
powershell -ExecutionPolicy Bypass -File start-relay.ps1

# 로그인 자동 시작 등록/해제 (작업 스케줄러, 현재 사용자)
powershell -ExecutionPolicy Bypass -File start-relay.ps1 -Install
powershell -ExecutionPolicy Bypass -File start-relay.ps1 -Uninstall

# CLI 도 데몬이 없으면 알아서 띄운다. --project 생략 시 기본 프로젝트
node cli.js refs PlayerController AudioManager NetworkBehaviour --filter Assets/Scripts
node cli.js workspace <플러그인>/tools/lsp-relay/test-fixture --name test-fixture   # 검증용 작은 C# 솔루션 등록
node cli.js refs Fixture.Greeter --project test-fixture
node cli.js defs AudioManager.PlaySfx NetworkBehaviour.OnStartClient
node cli.js outline Assets/Scripts/Audio/AudioManager.cs
node cli.js refs Util Util.add shared.Util.add --project MyRobloxGame   # Luau
node cli.js outline src/shared/Util.luau --project MyRobloxGame
node cli.js workspace                                   # 프로젝트 목록·상태
node cli.js workspace D:/Other/Proj [sln] --name Other [--pinned]   # 프로젝트 추가
node cli.js workspace D:/Projects/MyRobloxGame --lang luau            # Luau(Rojo) 프로젝트 추가
node cli.js status
node cli.js stop
```

- 로그: `~/.lsp-relay/relay.log` (프로젝트별 줄은 `[이름]` 으로 시작)
- 포트 변경: 환경변수 `LSP_RELAY_PORT`
- 큰 솔루션은 로딩에 수십 초 걸린다(중간 규모 Unity 프로젝트 약 13~19초 + 예열 약 4초). 로딩 중 들어온 질의는 끝날 때까지 기다렸다 처리된다.

## 프로젝트 (`~/.lsp-relay/projects.json`)

```json
{
  "default": "MyUnityGame",
  "idle_minutes": 30,
  "max_running": 2,
  "projects": {
    "MyUnityGame":   { "root": "D:/Projects/MyUnityGame", "solution": "MyUnityGame.sln", "pinned": true },
    "MyRobloxGame":  { "root": "D:/Projects/MyRobloxGame", "lang": "luau" }
  }
}
```

- `root` 는 절대경로(또는 projects.json 이 있는 폴더 기준 상대경로), `solution` 은 root 기준(생략하면 root 의 유일한 .sln).
- `lang` 은 `csharp`(기본, 생략 가능) 또는 `luau`. luau 는 `solution` 대신 root 의 `default.project.json`(Rojo)을 쓴다 — 아래 [Luau](#luau-luau-lsp) 참고.
- `default` 는 `project` 를 생략했을 때 쓰는 프로젝트다. 도구로는 바꿀 수 없다(다른 세션에 영향을 주는 전환은 없다) — 파일을 고친다.
- 파일을 손으로 고쳐도 데몬 재시작 없이 다음 질의(또는 10초 안의 점검)부터 반영된다. 빠지거나 root 가 바뀐 프로젝트는 내려간다.
- 프로젝트는 처음 질의될 때 로드되고, 그 뒤로는 계속 떠 있다. 로드는 프로젝트당 한 번만 치르는 게 목표다.

### 수명

- `pinned: true` — 자동 종료하지 않는다. 데몬이 시작되면 질의 없이도 바로 로드한다.
- 비고정 — 마지막 질의 후 `idle_minutes`(기본 30) 지나면 종료. 다시 질의하면 다시 로드한다.
- `max_running`(기본 2, 고정 포함) — 새 프로젝트를 띄울 때 넘치면 질의 중이 아닌 비고정 프로젝트를 가장 오래 안 쓴 것부터 내린다. 내릴 게 없으면(전부 고정) 상한을 넘겨 띄우고 로그에 남긴다.
- 재로드 중에는 같은 프로젝트의 csharp-ls 가 잠깐 2개가 된다(상한 계산에 넣지 않는다).

### 재로드 (csproj/sln 변경, csharp)

루트 아래 `.csproj`/`.sln` 의 mtime 이 바뀌면(1.5초 모아서 판단) 그 프로젝트만 새 csharp-ls 를 백그라운드로 로드한다. 로드(+예열)가 끝나면 새 서버로 바꾸고, 기존 서버는 진행 중인 질의가 끝난 뒤 종료한다. 그 전까지는 기존 서버가 답하고 결과 첫 줄에 다음이 붙는다.

```
(재로드 중: Fixture/Fixture.csproj 변경 — 기존 csharp-ls 로 응답)
```

재로드 중에 또 바뀌면 끝난 뒤 한 번 더 한다. Unity 가 csproj 를 다시 만들 때(스크립트 추가 등) 자동으로 따라간다.

## MCP 등록 (Claude Code)

```bash
claude mcp add --transport http --scope user lsp-relay http://127.0.0.1:7420/mcp
```

상태 없는 Streamable HTTP 라서 세션 여러 개가 동시에 붙어도 된다. 데몬이 떠 있어야 도구가 보인다.

## 도구

MCP 도구와 `POST /api/<tool>` (JSON 본문 → 텍스트 응답) 가 같은 로직을 쓴다.

모든 질의 도구에 `project?`(이름 대소문자 무시, 또는 root 경로)가 있고, 생략하면 기본 프로젝트를 쓴다. 없는 프로젝트면 등록된 이름 목록과 함께 오류를 낸다.

| 도구 | 인자 | 하는 일 |
|---|---|---|
| `refs` | `project?`, `symbols: string[]`, `context_lines=0`, `path_filter?`, `limit=80` | 심볼별 정의 위치 + 참조를 파일별로 묶어 `줄번호 \| 줄 내용` 으로. 머리줄 `심볼: N refs / M files`. 상한을 넘으면 `… 외 N개` |
| `defs` | `project?`, `symbols: string[]` | 정의 위치와 시그니처 한 줄 |
| `outline` | `project?`, `files: string[]` | 파일별 타입·멤버 목록 (`줄 종류 이름 : 타입`, .luau 는 최상위 `줄 종류 이름(매개변수)`). 경로는 프로젝트 root 기준 |
| `workspace` | `root?`, `name?`, `solution?`, `pinned?`, `lang?` | 인자 없으면 프로젝트 목록·상태(이름 옆 `[csharp]`/`[luau]`). `root` 를 주면 projects.json 에 추가(로드는 첫 질의 때). 기본 프로젝트는 바꾸지 않는다 |

`GET /health` 는 `{ ok, pid, default, idle_minutes, max_running, projects: [{ name, root, lang, pinned, running, loaded, reloading, lspPid, idleSec }] }` 를 준다.

### 심볼 표기 (C#)

- `Type`, `Ns.Type`, `Type.Member`, `Ns.Type.Member`, 멤버 이름만(`PlaySfx`)도 된다.
- 같은 이름이 여러 개면 후보 목록이 나온다. 네임스페이스를 붙이거나 `Type@경로일부` 로 좁힌다. 예: `Greeter@Sub/`, `Greeter@Other.cs`
- 부분 클래스는 하나로, 멤버 오버로드는 참조를 합쳐서 보여 준다.
- `path_filter` 는 부분 문자열(대소문자 무시) 또는 글롭(`*`, `**`). 머리줄에 전체 수와 필터 후 수가 같이 나온다.

### 출력 예

```
GameDebug: 102 refs / 32 files
  정의 Assets/Scripts/Debug/GameDebug.cs:10 | public static class GameDebug
Assets/Scripts/Audio/AudioManager.cs
  85 | Muted = GameDebug.Arg("-mute") != null
  99 | string setvol = GameDebug.Arg("-setvol");
…
… 외 17개 refs (5 files 더) — path_filter 나 limit 로 좁혀라
```

`context_lines` 를 주면 참조 줄은 `줄 |`, 주변 줄은 `줄 -` 로, 떨어진 구간은 `--` 로 나뉜다.

## Luau (luau-lsp)

`lang: "luau"` 프로젝트는 luau-lsp 를 `lsp --definitions=@roblox=<root>/tools/types/globalTypes.d.luau` 로 띄운다(정의 파일이 없으면 빼고 띄우고 로그에 남긴다).

- **sourcemap**: 데몬이 `rojo sourcemap default.project.json -o <임시폴더>/lsp-relay/<이름>-<해시>/sourcemap.json` 으로 만들어 luau-lsp 설정(`sourcemap.sourcemapFile`, autogenerate 끔)으로 넘긴다. 프로젝트 폴더에는 아무것도 쓰지 않는다. `.luau` 추가·삭제나 `*.project.json` 변경 때 질의 직전에 다시 만들고 `workspace/didChangeConfiguration` 으로 다시 읽힌다(약 0.2초).
- **로딩**: luau-lsp 도 첫 문서 요청이 와야 정의 파일(약 5초)·색인을 로드한다. 그래서 시작 직후 파일 하나의 documentSymbol 응답을 로딩 완료로 본다. 첫 질의는 약 5초, 그 뒤는 수십 ms.
- luau-lsp 는 연(didOpen) 문서에만 답하므로 질의에 필요한 파일을 데몬이 그때그때 연다. 연 파일이 디스크에서 바뀌면 전체 내용으로 didChange 를 보낸다.

### 심볼 표기 (Luau)

모듈 = Rojo 규칙의 모듈 이름(파일 이름에서 `.server`/`.client`·확장자를 뗀 것, `init.*` 이면 폴더 이름). 클래스 대신 모듈이 C# 의 타입 자리에 온다.

| 표기 | 뜻 | 예 |
|---|---|---|
| `Module` | 모듈 자체. 정의는 파일 끝 `return X` 의 `local X`, 참조는 그 변수(다른 파일의 `require` 줄과 사용처 포함) | `Util` |
| `Module.member` | 모듈 테이블의 함수·필드(`Util.f`, `Util:m`, `Util.Sub.f`) 또는 그 파일 최상위 `local`·`type` | `Util.add`, `Util.Point`, `Obj.greet`(= `Obj:greet`) |
| `폴더.Module.member` | 모듈 이름 앞에 경로 폴더를 붙여 좁힘 (C# 의 네임스페이스 자리) | `shared.Util.add` |
| `파일.luau:이름` | 파일을 직접 지정 (root 기준) | `src/shared/Util.luau:add` |
| `이름` | 모듈 이름이 아니면 workspace/symbol 로 이름 검색 | `add`, `helper` |

- 동명 후보는 목록이 나오고, C# 와 같이 `이름@경로일부` 로 좁힌다. 예: `add@client`
- 결과의 이름은 모듈 테이블 변수 대신 모듈 이름으로 보여 준다(`local M = {}` 인 Util.luau 의 `M.add` → `Util.add`).
- 참조에서 정의 줄은 뺀다(luau-lsp 는 선언·초기값 `{}` 을 참조로 넣어 준다).
- `return function() … end` 처럼 모듈 변수가 없는 모듈은 참조로 `require` 줄만 찾는다(각 줄의 모듈 이름 위치를 textDocument/definition 으로 확인). 받은 변수의 사용처는 그 변수로 다시 질의하지 않으면 안 나온다.

## 최신성

데몬이 루트 아래를 `fs.watch` 로 감시해 바뀐 소스 파일(`.cs`, luau 는 `.luau`/`.lua`) 경로만 모아 두고, 질의 직전에 그 파일들의 mtime 을 확인해 `workspace/didChangeWatchedFiles` 로 언어 서버에 알린다(생성·수정·삭제). luau 는 위 sourcemap 재생성도 이때 한다. 바뀐 게 없으면 추가 비용이 없다. 감시가 실패하면 질의마다 전체 스캔(중간 규모 프로젝트 약 65ms)으로 대신한다. `Library`, `Temp`, `obj`, `bin` 등은 제외한다.

- Unity 의 옛 형식 csproj 는 Unity 가 csproj 를 다시 만들기 전까지 새 파일을 모를 수 있다. csproj 가 다시 만들어지면 위의 재로드가 따라간다.
- 로딩이 끝나면 예열 질의(workspace/symbol → documentSymbol → references 한 번)를 보내 첫 질의 지연(중간 규모 프로젝트 약 3초)을 로딩 단계에서 치른다. 그래서 미리 로드된 고정 프로젝트는 첫 질의도 1초 미만이다.

## 파일

- `server.js` 데몬 (HTTP, MCP, API)
- `relay.js` 프로젝트별 워크스페이스(csharp `Workspace`, luau `LuauWorkspace`)·수명·재로드 관리 + 도구 로직
- `~/.lsp-relay/projects.json` 프로젝트 설정 (데몬이 만든다. `LSP_RELAY_HOME` 으로 위치 변경)
- `lsp.js` 언어 서버 JSON-RPC 클라이언트 (csharp-ls·luau-lsp 공용)
- `cli.js` CLI
- `start-relay.ps1` 백그라운드 시작, `-Install`/`-Uninstall` 로그인 자동 시작 등록·해제
- `test-fixture/` 검증용 작은 C# 솔루션, `test/mcp-smoke.js` MCP 동시 접속 스모크 테스트(`LSP_PROJECT` 로 프로젝트 지정)
