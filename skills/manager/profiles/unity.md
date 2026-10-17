# 프로필: unity

대상: Unity 프로젝트(git, main 폴더는 에디터 상시 실행). 피처 브랜치는 `<main>-wt/<이름>` worktree (에디터·Library 없음).
아래 `<프로젝트>` 는 lsp-relay 에 등록한 프로젝트 이름(기본: 프로젝트 폴더 이름)이다.

## 브리프에 넣을 규칙
- Unity 코드 변경 후에는 컴파일 검사. worktree 면 `node "${CLAUDE_PLUGIN_ROOT}/tools/unity-check/check.js" <이름>` (종료 코드 0 통과 / 1 실패 / 2 검사 불가).
- C# 심볼 정의·참조 찾기는 grep 대신 **lsp-relay MCP**(`refs`/`defs`/`outline`, 여러 심볼을 한 번에, `project: "<프로젝트>"`)를 먼저 쓴다. grep 은 문자열·주석 검색에만. 데몬이 없으면 `node "${CLAUDE_PLUGIN_ROOT}/tools/lsp-relay/cli.js" status` 로 띄운다.
- 브랜치에서는 코드만. 씬·프리팹·SO 연결과 `Packages/manifest.json` 변경은 main(에디터)에서.

## 게이트
- worktree 는 `check.js new <이름>` 으로 만들면 Stop 훅 완료 게이트(`gate.js`)가 붙는다. 세부: `${CLAUDE_PLUGIN_ROOT}/tools/unity-check/README.md`.
- main 폴더는 현재 폴더(또는 인자로 준 경로)가 속한 git 저장소에서 찾는다. 다른 곳에서 부르면 `UNITY_CHECK_MAIN` 으로 지정한다.
- 결과: `%TEMP%/unity-check/gate/<이름>-*/result.json` → `result` 가 pass 가 아니거나 `gave_up` 이면 워커 보고를 믿지 않는다.
- 게이트 훅은 worktree 를 만들 때의 플러그인 경로를 적어 둔다. 플러그인을 업데이트했으면 진행 중인 worktree 는 `remove` 뒤 `new` 로 다시 만든다.

## 검증
- 컴파일 검사 (worktree 는 unity-check, main 은 unity-mcp / Unity CLI 등 사용 가능한 것).
- 필요하면 빌드·실행 로그 확인.

## 병렬 제약
- Unity 에디터는 프로젝트 폴더당 하나. 에디터를 쓰는 검증은 main 에서 한 번에 하나만.

## 처음부터 L2
- 네트워크 동기화(Mirror·Netcode 등) 작업.
