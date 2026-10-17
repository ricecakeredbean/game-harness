# game-harness

Claude Code 로 게임(Roblox / Unity)을 만들 때 쓰는 **"매니저 세션 1 + 워커 세션 N" 하네스** 플러그인이다.
사용자는 매니저 세션하고만 대화하고, 매니저가 요구 정리 → 태스크 쪼개기 → 워커 세션 배정 → 검증 → 보고를 맡는다.

*A Claude Code plugin for a "1 manager session + N worker sessions" workflow for Roblox (Rojo) and Unity projects: a manager skill with engine profiles, a one-shot setup skill, completion gates (roblox-check / unity-check), and lsp-relay, a shared language-server daemon for symbol lookups. Docs are in Korean.*

## 들어 있는 것

| 구성 | 하는 일 |
| :- | :- |
| `manager` 스킬 | 매니저 규약. 상태 파일(`harness/goal.md`·`tasks.json`·`progress.md`·`decisions.md`), 워커 모델·effort 사다리, 검증 규칙. 엔진 프로필 `profiles/roblox.md`·`unity.md` |
| `harness-setup` 스킬 | 이 PC·프로젝트를 점검하고 빠진 것만 셋팅 (단계마다 확인을 받는다) |
| `tools/roblox-check` | Rojo 프로젝트 검사: rojo sourcemap → luau-lsp(strict) → selene → StyLua. worktree 생성 + Stop 훅 완료 게이트 |
| `tools/unity-check` | 에디터 없는 worktree 의 C# 를 main 의 csproj/Library 로 `dotnet build` 검사 + 완료 게이트 |
| `tools/lsp-relay` | csharp-ls / luau-lsp 를 프로젝트마다 하나만 띄우고 여러 세션이 MCP(`refs`/`defs`/`outline`)로 질의하는 데몬 |

## 설치 (두 줄)

터미널의 `claude` 에서:

```
/plugin marketplace add <owner>/<repo>
/plugin install game-harness@game-harness
```

셸에서는 `claude plugin marketplace add <owner>/<repo>` 뒤 `claude plugin install game-harness@game-harness`.
데스크톱 앱에서는 입력창 옆 **+** → **Plugins** → **Add marketplace** 에 `<owner>/<repo>` → **Add plugin**.

## 셋업 (한 번)

게임 프로젝트 폴더에서 새 세션을 열고:

```
/game-harness:harness-setup
```

Claude 가 Node·git 확인 → 엔진 선택(Roblox/Unity) → 엔진 도구(Roblox: Rokit·Rojo·luau-lsp·selene·StyLua·타입 정의·Studio MCP / Unity: .NET SDK·csharp-ls) → lsp-relay 설치·기동·MCP 등록 → `harness/` 상태 파일 → 검사 실행까지 한다. 이미 된 단계는 건너뛰고, 설치·설정 변경 전에는 물어본다.

셋업이 끝나면 **세션을 새로 연다** (MCP 는 세션을 시작할 때 붙는다).

## 쓰는 법

- 새 세션에서 "매니저 모드로 상점 UI 만들어 줘" 처럼 말한다 → `game-harness:manager` 스킬이 `harness/` 에 목표·태스크를 정리하고 워커 세션을 띄워 맡긴 뒤, 결과를 직접 검증해서 보고한다.
- 워커는 `check.js new <이름>` 으로 만든 git worktree 에서 일하고, 끝내려 하면 완료 게이트(Stop 훅)가 검사를 돌려 깨진 상태로는 못 끝낸다.
- 심볼 찾기는 grep 대신 lsp-relay MCP (`refs`/`defs`/`outline`).
- 도구 세부는 각 `tools/*/README.md`.

## 한계

- **Windows 위주로 검증했다.** Mac 경로(Rokit, Studio MCP, csharp-ls)는 넣어 두었지만 실제로 돌려 보지 않았다. unity-check 는 Windows 에서만 검증했다.
- 워커 배정은 **Claude 데스크톱 앱(Code 탭)의 세션 시작(`start_session`)** 기준이다. 터미널 CLI 만 쓰면 워커 세션을 직접 열어 브리프를 붙여 넣어야 한다.
- 다른 세션의 메시지나 자동 이벤트로 시작된 턴에서는 앱이 새 세션 시작을 막는다. 그때는 서브에이전트로 대신하거나 사용자가 제안 카드를 눌러 시작한다.
- 플러그인을 업데이트하면 설치 폴더가 바뀐다 → `/game-harness:harness-setup` 을 다시 실행해 lsp-relay 의존성·자동 시작을 다시 맞추고, 진행 중인 worktree 의 게이트는 다시 만든다.
- lsp-relay 설정·로그는 `~/.lsp-relay/` 에 있다 (`LSP_RELAY_HOME` 으로 변경, 포트는 `LSP_RELAY_PORT`, 기본 7420).
- 워커 모델 사다리는 Sonnet/Opus 5.5 기준이고 Haiku 는 쓰지 않는 것이 기본 규칙이다 (`skills/manager/SKILL.md` 3-1 에서 바꿀 수 있다).
