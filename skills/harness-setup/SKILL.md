---
name: harness-setup
description: game-harness 셋업 — 이 PC 와 현재(또는 지정한) 게임 프로젝트에 매니저+워커 하네스 도구를 점검하고 셋팅한다 (Node, Roblox 면 Rokit·Rojo·luau-lsp·selene·StyLua·Studio MCP, Unity 면 dotnet·csharp-ls, 공통 lsp-relay·harness 상태 파일). 사용자가 "하네스 셋업", "harness setup", "game-harness 설치/설정" 이라고 하거나 /game-harness:harness-setup 을 실행했을 때 사용.
argument-hint: "[프로젝트 경로]"
---

# game-harness 셋업

플러그인 루트: `${CLAUDE_PLUGIN_ROOT}` (아래 `<ROOT>`). 셸에는 이 환경변수가 없으니 명령에는 이 실제 경로를 넣는다.

## 진행 규칙
- 사용자와 한국어로 대화한다 (사용자가 다른 언어로 말하면 그 언어로).
- **단계마다 먼저 점검하고, 이미 되어 있으면 "이미 됨" 이라고만 하고 건너뛴다.**
- **설치·다운로드·설정 변경(파일 생성, `claude mcp add`, 작업 스케줄러 등록, git 커밋 등) 전에는 무엇을 할지 한 줄로 보여 주고 사용자 확인을 받는다** (AskUserQuestion, 첫 선택지가 권장). 여러 개를 한 번에 물어도 된다.
- 비밀번호·API 키·토큰은 묻지도 입력하지도 않는다. 관리자 권한이 필요한 설치는 사용자가 직접 하도록 명령만 알려 준다.
- 실패하면 원인을 출력으로 확인하고 고칠 수 있는 건 고친다. 추측으로 "됐다" 고 하지 않는다.
- 끝에 표로 결과(됨 / 건너뜀 / 사용자 할 일)를 보고한다.

OS 판정: `node -p process.platform` → `win32` / `darwin` / `linux`. 명령 예시는 Bash(POSIX) 기준이고, Windows 에서 PowerShell 도구를 쓰면 문법을 맞춘다.

## 1. 기본 도구
- `node -v` — 18 이상 필요 (24 에서 검증). 없거나 낮으면 https://nodejs.org 의 LTS 설치를 안내하고 멈춘다 (Windows `winget install OpenJS.NodeJS.LTS`, Mac `brew install node`).
- `git --version` — 없으면 설치 안내 (Windows `winget install Git.Git`, Mac `xcode-select --install`).

## 2. 프로젝트와 엔진
- 프로젝트 폴더: 인자로 받은 경로 → 없으면 현재 폴더. 현재 폴더가 게임 프로젝트로 보이지 않으면 경로를 묻는다 (새로 만들 경우 빈 폴더 경로).
- 엔진 판정: `default.project.json` 있으면 Roblox, `ProjectSettings/` 있으면 Unity. 둘 다 없으면 AskUserQuestion 으로 Roblox / Unity 를 고르게 한다.
- git 저장소가 아니면 (`git -C <프로젝트> rev-parse --show-toplevel` 실패) 확인 후 `git init -b main`. 게이트·worktree 가 git 을 쓴다. 첫 커밋은 엔진 셋업이 끝난 뒤 한다 (아래 6).

## 3-R. Roblox
1. **Rokit**: `rokit --version` (안 잡히면 `~/.rokit/bin/rokit`). 없으면 확인 후 설치:
   - Windows (PowerShell): `Invoke-RestMethod https://raw.githubusercontent.com/rojo-rbx/rokit/main/scripts/install.ps1 | Invoke-Expression`
   - Mac/Linux: `curl -sSf https://raw.githubusercontent.com/rojo-rbx/rokit/main/scripts/install.sh | bash`
   - 설치 뒤 이 세션의 PATH 에는 없을 수 있다 → `~/.rokit/bin/rokit` 으로 부른다.
2. **프로젝트 파일** (`<ROOT>/skills/harness-setup/templates/roblox/`): 프로젝트에 없는 파일만 복사한다. 있는 파일은 덮어쓰지 않고, 다르면 차이만 알려 준다.
   - `rokit.toml`, `.luaurc`(strict), `selene.toml`, `stylua.toml`, `gitignore` → `.gitignore`(있으면 빠진 줄만 추가 제안)
   - `gitattributes` → `.gitattributes` (LF 고정. 없으면 Windows worktree 에서 CRLF 로 풀려 stylua 검사가 전부 실패한다. 이미 있으면 `eol=lf` 가 있는지만 확인)
   - `default.project.json` — 없을 때만. `__PROJECT_NAME__` 을 폴더 이름으로 바꾼다. 코드 폴더(Shared/Server/Client)만 매핑한다 (`rojo init` 은 Workspace 등도 매핑하므로 쓰지 않는다).
   - `src/shared|server|client` 가 비었으면 템플릿의 예제 스크립트 3개를 넣을지 묻는다 (게이트 동작 확인용).
3. **도구 설치**: 프로젝트 폴더에서 `rokit install` (trust 질문으로 멈추면 `rokit install --no-trust-check`). 확인: `rojo --version`, `luau-lsp --version`, `selene --version`, `stylua --version`, `lune --version` (PATH 앞에 `~/.rokit/bin`).
4. **Roblox 타입 정의**: `tools/types/globalTypes.d.luau` 가 없으면 확인 후 다운로드:
   `curl -fsSL -o tools/types/globalTypes.d.luau https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/main/scripts/globalTypes.d.luau` (폴더 먼저 만들기). selene 의 roblox 표준 라이브러리는 첫 실행 때 selene 이 알아서 받는다.
5. **Studio MCP**: `claude mcp get Roblox_Studio` 가 성공하면 건너뛴다. 없으면 확인 후 등록:
   - Windows: `claude mcp add --scope user Roblox_Studio -- cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat` (먼저 `%LOCALAPPDATA%\Roblox\mcp.bat` 이 있는지 확인 — 없으면 Studio 를 최신으로 업데이트하고 한 번 실행하라고 안내)
   - Mac: `claude mcp add --scope user Roblox_Studio -- /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`
   - 그다음 사용자에게 Studio 쪽 스위치를 켜 달라고 안내한다: Studio 오른쪽 위 공유 버튼 옆 **고리 모양 아이콘(AI 어시스턴트)** → 패널 오른쪽 위 **…** → **설정** → **MCP 서버** 탭 → **Studio를 MCP 서버로 사용** 켜기 (영어 UI: Assistant → … → Manage MCP Servers → "Enable Studio as MCP server"). 꺼져 있으면 도구가 0개로 보인다. Studio 를 다시 켜면 꺼져 있을 수 있다.
   - 등록한 MCP 는 **새 세션부터** 보인다.
6. **Rojo Studio 플러그인**: Studio 에 Rojo 플러그인이 없으면 `rojo plugin install` (확인 후) 또는 Creator Store 의 Rojo 플러그인 설치를 안내한다.

## 3-U. Unity
1. **.NET SDK**: `dotnet --list-sdks` — 없으면 https://dotnet.microsoft.com/download 에서 .NET SDK(8 이상, 9 에서 검증) 설치를 안내 (Windows `winget install Microsoft.DotNet.SDK.9`, Mac `brew install --cask dotnet-sdk`).
2. **csharp-ls**: `dotnet tool list -g` 에 `csharp-ls` 가 있으면 건너뛴다. 없으면 확인 후 `dotnet tool install --global csharp-ls` (0.28.0 에서 검증. 안 맞으면 `--version 0.28.0`). 위치: `~/.dotnet/tools/csharp-ls(.exe)`.
3. **csproj**: 프로젝트 루트에 `Assembly-CSharp.csproj` 가 없으면 사용자에게 Unity 에디터로 프로젝트를 한 번 열고, 외부 도구(External Tools)에서 `.csproj` 생성(Regenerate project files)을 하라고 안내한다. unity-check·lsp-relay 둘 다 필요하다.
4. 참고: unity-check 는 Windows 에서만 검증했다. Mac 에서는 실패할 수 있다고 미리 알린다.

## 4. lsp-relay (공통, 심볼 탐색 중계 데몬)
1. **의존성**: `<ROOT>/tools/lsp-relay/node_modules` 가 없으면 확인 후 `npm install --prefix "<ROOT>/tools/lsp-relay"` (플러그인을 업데이트하면 폴더가 바뀌니 다시 필요하다).
2. **기동**: `node "<ROOT>/tools/lsp-relay/cli.js" status` (데몬이 없으면 띄운다). 설정·로그는 `~/.lsp-relay/` 에 있다.
   - 다른 버전의 플러그인에서 띄운 데몬이 이미 떠 있으면 `node "<ROOT>/tools/lsp-relay/cli.js" stop` 뒤 다시 status.
3. **프로젝트 등록**: `node "<ROOT>/tools/lsp-relay/cli.js" workspace` 목록에 이 프로젝트 root 가 없으면 확인 후
   - Roblox: `node "<ROOT>/tools/lsp-relay/cli.js" workspace "<프로젝트>" --lang luau --pinned`
   - Unity: `node "<ROOT>/tools/lsp-relay/cli.js" workspace "<프로젝트>" --pinned` (.sln 이 여러 개면 sln 경로를 두 번째 인자로)
   - `--pinned` 는 데몬이 늘 띄워 두는 것 (메모리 수백 MB). 주 작업 프로젝트만 고정한다고 설명하고 고를 수 있게 한다.
   - 등록 이름(기본: 폴더 이름)을 사용자에게 알려 준다. 매니저·워커가 `project:` 에 쓴다.
4. **MCP 등록**: `claude mcp get lsp-relay` 가 성공하면 건너뛴다. 없으면 확인 후 `claude mcp add --transport http --scope user lsp-relay http://127.0.0.1:7420/mcp`. 데몬이 떠 있을 때만 도구가 보인다.
5. **로그인 자동 시작 (Windows, 선택)**: 물어보고 원하면 `powershell -ExecutionPolicy Bypass -File "<ROOT>/tools/lsp-relay/start-relay.ps1" -Install` (현재 사용자 작업 스케줄러, 관리자 권한 불필요). 플러그인 업데이트 뒤에는 다시 `-Install` 해야 한다. Mac/Linux 는 자동 시작이 없으니 세션을 열 때 `cli.js status` 로 띄우면 된다고 안내한다.

## 5. harness 상태 파일
- `<프로젝트>/harness/` 에 `<ROOT>/skills/manager/templates/` 의 `goal.md`, `tasks.json`, `progress.md`, `decisions.md` 중 없는 것만 복사한다 (있는 파일은 건드리지 않는다).
- `goal.md` 맨 아래에 `profile: roblox` 또는 `profile: unity` 줄이 없으면 추가한다. Roblox 면 플레이스 파일(.rbxl) 경로도 물어서 `- 플레이스 파일:` 줄로 적는다 (모르면 비워 둔다).

## 6. 동작 확인
- 셋업으로 바뀐 파일이 있으면 확인 후 첫 커밋 (`git add -A && git commit -m "game-harness 셋업"`). worktree 는 커밋된 것만 가져가기 때문이다.
- Roblox: `node "<ROOT>/tools/roblox-check/check.js" "<프로젝트>"` → 종료 코드 0 이면 통과. 1 이면 출력의 오류를 보여 주고(예제 스크립트면 고친다), 2 면 원인(도구 없음 등)을 고친 뒤 다시.
- Unity: main 폴더는 직접 검사하지 않으므로, 확인 후 임시 worktree 로 시험한다:
  `node "<ROOT>/tools/unity-check/check.js" new harness-smoke --no-gate` → `node "<ROOT>/tools/unity-check/check.js" harness-smoke` → `node "<ROOT>/tools/unity-check/check.js" remove harness-smoke --force` (프로젝트 폴더에서 실행. 브랜치 `feature/harness-smoke` 도 지워진다).
- lsp-relay: 프로젝트의 코드 파일 하나로 `node "<ROOT>/tools/lsp-relay/cli.js" outline <상대경로> --project <이름>` 이 목록을 돌려주는지 확인 (Unity 첫 로드는 수십 초 걸릴 수 있다).

## 7. 마무리 보고
- 표: 단계 / 결과(됨·이미 됨·건너뜀·실패) / 사용자 할 일.
- 꼭 알릴 것:
  - **MCP(lsp-relay·Roblox_Studio)는 새 세션부터 보인다** → 이 세션을 닫고 프로젝트 폴더에서 새 세션을 연다.
  - 쓰는 법: 새 세션에서 "매니저 모드로 ○○ 만들어 줘" 처럼 말하면 `game-harness:manager` 스킬이 계획·워커 배정·검증을 맡는다. 워커 세션은 Claude 데스크톱 앱의 세션 시작 기능을 쓴다.
  - Roblox 면 Studio 의 "Studio를 MCP 서버로 사용" 스위치와 Rojo 플러그인 연결(`rojo serve`)은 사용자가 Studio 에서 확인해야 한다.
