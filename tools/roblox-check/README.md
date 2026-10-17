# roblox-check

Rojo 프로젝트(Roblox, strict Luau)를 `rojo sourcemap` → `luau-lsp analyze` → `selene` → `stylua --check` 로 검증한다. unity-check 의 Roblox 판.

## 사용법
```
node check.js <worktree 경로|이름>        # 검사 (이름이면 <main>-wt/<이름>; main 경로도 가능)
node check.js new <이름> [--no-gate]      # 브랜치 feature/<이름> + worktree 생성 (+ 완료 게이트 훅)
node check.js remove <이름> [--force]     # worktree + 브랜치 삭제 (+ 임시 폴더)
```
환경변수: `ROBLOX_CHECK_MAIN`(기본: 인자로 준 경로나 현재 폴더가 속한 git 저장소의 main worktree), `ROBLOX_CHECK_BASE`(비교 기준 브랜치; 기본 main → 없으면 master → 없으면 main 폴더 현재 브랜치.).
도구는 `%USERPROFILE%\.rokit\bin` 을 PATH 앞에 두고 실행한다.

## 종료 코드
0 통과 / 1 검사 실패 / 2 검사 불가 (프로젝트 설정 변경, 도구 없음, rojo 실패 포함)

## 검사 내용 (프로젝트 루트 기준)
1. `rojo sourcemap default.project.json -o <임시>/sourcemap.json` — 산출물은 `%TEMP%/roblox-check/<이름>-<해시>/` 에만 쓴다.
2. `luau-lsp analyze --sourcemap=… --definitions=@roblox=tools/types/globalTypes.d.luau src` (종료 1이면 실패)
3. `selene --display-style=quiet src` (종료 비0이면 실패)
4. `stylua --check src` (종료 비0이면 실패; 파일별 첫 변경 줄을 표시)
세 도구는 모두 돌린 뒤 결과를 합친다. 종료 코드는 실패인데 파싱된 줄이 없으면 원문 꼬리를 오류로 보인다.

## 출력
짧은 텍스트(`상대경로:줄 도구/종류 메시지`, 최대 20개) + 마지막 줄 `JSON: <경로>`.
JSON: `{result, exit_code, duration_s, errors:[{tool,severity,file,line,kind,msg}], warnings_count, notes}`
(실패한 도구의 경고성 줄도 오류로 올려 보여준다. 통과한 도구의 경고만 `warnings_count`.)

## 차단 규칙
브랜치(worktree)에서 `default.project.json`·`rokit.toml`·`*.rbxl(x)` 가 바뀌었으면(기준 브랜치 대비 diff + 작업 트리) 검사 없이 exit 2, "프로젝트 설정 변경은 main 에서 하세요". main 폴더 자체를 검사할 때는 적용하지 않는다.

## 완료 게이트 (gate.js, Stop 훅)
- `check.js new` 가 worktree 에 `.claude/settings.local.json` 을 쓴다: Stop 훅 `node "<roblox-check>/gate.js"` (timeout 900초) + check.js 실행 허용. 공용 `.git/info/exclude` 에 등록해 git 에 안 섞인다. `--no-gate` 면 생략. main·전역 설정에는 넣지 않는다.
- 워커가 끝내려 하면 게이트가 돈다 (stdin JSON `{cwd, stop_hook_active}`; `CLAUDE_PROJECT_DIR` 우선):
  - 마지막 통과 이후 변경이 없으면(HEAD + 작업 트리의 .lua/.luau·프로젝트 설정·tools/ 지문) 검사 없이 exit 0.
  - 통과 → exit 0, 연속 실패 카운터 초기화.
  - 검사 실패 → exit 2, stderr 에 오류 상위 10개와 "고친 뒤 다시 끝내라".
  - 프로젝트 설정 변경 → exit 2, main 에서 하라는 안내.
  - 도구 없음 등 검사 불가 → exit 0, 경고만 (result `unsupported`).
  - 연속 실패 3회 → exit 0 으로 종료 허용, `gave_up: true` 로 기록 (매니저가 상향 판단).
- 결과 JSON (매니저가 읽는 곳): `%TEMP%/roblox-check/gate/<이름>-<해시>/result.json` (마지막 결과), 같은 폴더 `history.jsonl` (한 줄씩), `state.json` (지문·카운터).
  `{time, worktree, result: pass|fail|project_blocked|unsupported, exit_code, errors_top, consecutive_failures, stop_hook_active, duration_s, skipped?, gave_up?, warning?}`
  확인 예: `cat "$TEMP"/roblox-check/gate/<이름>-*/result.json` → result 가 pass 가 아니거나 gave_up 이면 워커 보고를 믿지 말 것.
- `remove` 는 gate 폴더를 지우지 않는다(기록 보존).

## 한계
- 게이트 지문은 `src` 밖 파일(예: docs)만 바뀌면 영향 없음으로 본다. `tools/` 변경은 재검사.
- Studio 안의 런타임 동작·`.rbxl` 은 검사하지 않는다.
