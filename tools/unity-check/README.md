# unity-check

에디터·Library 없는 git worktree 의 Unity C# 코드를 main 의 csproj/Library 를 빌려 `dotnet build` 로 컴파일 검증한다.

## 사용법
```
node check.js <worktree 경로|이름> [--no-meta]   # 검사 (이름이면 <main>-wt/<이름>)
node check.js new <이름> [--no-gate]              # 브랜치 feature/<이름> + worktree 생성 (+ 완료 게이트 훅)
node check.js remove <이름> [--force]             # worktree + 브랜치 삭제 (+ 임시 빌드 폴더)
```
환경변수: `UNITY_CHECK_MAIN`(기본: 인자로 준 경로나 현재 폴더가 속한 git 저장소의 main worktree), `UNITY_CHECK_BASE`(기본 main).

## 종료 코드
0 통과 / 1 컴파일 실패 / 2 검사 불가 (패키지 변경, 새 asmdef, 환경 문제 포함)

## 출력
짧은 텍스트(오류 `상대경로:줄 코드 메시지`, 중복 제거, 최대 20개, 경고는 개수) + 마지막 줄 `JSON: <경로>`.
JSON: `{result, exit_code, duration_s, assemblies, errors:[{file,line,code,msg}], warnings_count, notes}`

## 동작
- main 의 모든 `*.csproj` 를 임시 폴더(`%TEMP%/unity-check/<이름>-<해시>/proj`)에 사본으로 만들고 경로를 고친다: Compile/None/HintPath 의 `Library\` 는 main, 나머지는 worktree 절대 경로.
- worktree 에 없는 .cs 는 목록에서 빼고, 새 .cs 는 소속 어셈블리(가장 가까운 asmdef → 없으면 Editor/Plugins 폴더 규칙)에 넣는다. 새 Assets 안 DLL 은 Reference 로 추가.
- 소스가 하나도 안 남은 프로젝트(예: Editor-firstpass)는 빌드에서 뺀다.
- 새 파일·폴더의 `.meta` 를 생성한다 (`--no-meta` 로 끔).
- 빌드 산출물·obj 도 같은 임시 폴더. worktree 별로 재사용해 재실행은 증분 빌드(첫 30여 초, 이후 5~10초).
- `UseSharedCompilation=false`: 컴파일 서버가 main Library DLL 을 붙잡고 있지 않게 한다.

## 한계
- Mirror Weaver(ILPP) 미실행, DefineConstants 는 에디터 기준 → 최종 판정은 main 에디터.
- 경고 개수는 이번 실행에서 컴파일된 어셈블리만 센다 (증분 빌드에서 건너뛴 어셈블리 경고는 빠짐).
- 새 asmdef/asmref, asmdef 없는 Packages 소스는 종료 코드 2. asmdef 수정은 csproj 에 반영되지 않음(notes 로 알림).
- 패키지 변경(Packages/manifest.json, packages-lock.json)은 main 에서만.

## 완료 게이트 (gate.js, Stop 훅)
- `check.js new` 가 worktree 에 `.claude/settings.local.json` 을 쓴다: Stop 훅 `node "<unity-check>/gate.js"`, timeout 900초. 공용 `.git/info/exclude` 에 `.claude/settings.local.json` 을 등록해 git 에 안 섞인다. `--no-gate` 면 생략. main·매니저 폴더·전역 설정에는 넣지 않는다.
- 워커가 끝내려 하면 게이트가 돈다:
  - 마지막 통과 이후 .cs·asmdef·asmref·Packages 변경이 없으면(HEAD + 작업 트리 지문) 빌드 없이 exit 0 (0.3초 안팎).
  - 통과 → exit 0, 연속 실패 카운터 초기화.
  - 컴파일 실패 → exit 2, stderr 에 오류 상위 10개와 "고친 뒤 다시 끝내라" (Claude 가 이어서 작업).
  - 패키지 변경 → exit 2, main 에서 하라는 안내.
  - 새 asmdef 등 검사 불가 → exit 0, 경고만 (result `unsupported`).
  - 연속 실패 3회 → exit 0 으로 종료 허용, `gave_up: true` 로 기록. 매니저가 사다리 상향 판단.
- 결과 JSON (매니저가 읽는 곳): `%TEMP%/unity-check/gate/<이름>-<해시>/result.json` (마지막 결과), 같은 폴더 `history.jsonl` (게이트마다 한 줄), `state.json` (지문·카운터).
  `{time, worktree, result: pass|fail|package_blocked|unsupported, exit_code, errors_top, consecutive_failures, stop_hook_active, duration_s, skipped?, gave_up?, warning?}`
  매니저 확인 예: `cat "$TEMP"/unity-check/gate/<이름>-*/result.json` → result 가 pass 가 아니거나 gave_up 이면 워커 보고를 믿지 말 것.
- Claude Code 자체도 Stop 훅 연속 차단 8회면 강제로 종료시킨다(문서). 게이트 상한 3회가 먼저 걸린다.
- `remove` 는 gate 폴더를 지우지 않는다(기록 보존).
