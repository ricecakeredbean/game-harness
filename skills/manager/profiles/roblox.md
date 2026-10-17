# 프로필: roblox

대상: Rojo 프로젝트(git). 플레이스 파일(`.rbxl`)은 프로젝트 폴더 밖이나 안에 두고 Studio 가 열어 둔다 (경로는 `harness/goal.md` 에 적어 둔다).
도구는 프로젝트의 `rokit.toml` 에 버전 고정 (rojo·luau-lsp·selene·StyLua·lune). 셸에서 안 잡히면 PATH 앞에 `~/.rokit/bin` (Windows `%USERPROFILE%\.rokit\bin`).
아래 `<프로젝트>` 는 lsp-relay 에 등록한 프로젝트 이름(기본: 프로젝트 폴더 이름)이다.

## 구조 원칙
- **코드의 원본은 파일**(`src/**/*.luau`). Studio 는 `rojo serve` + Rojo 플러그인으로 받아 보기만 한다. Studio 에서 스크립트를 직접 고치지 않는다.
- `default.project.json` 은 코드 폴더만 매핑한다 (Shared → ReplicatedStorage, Server → ServerScriptService, Client → StarterPlayerScripts). Workspace·Lighting 같은 월드는 매핑하지 않는다.
- **월드(맵·모델·지형·UI 배치)는 `.rbxl` 안에 있다.** 병합이 안 되므로 브랜치에서는 만들지 않고 main Studio 에서만 만든다 (Studio MCP 로 매니저가 하거나 사용자가 직접. 아래 "Studio MCP" 절).

## 브리프에 넣을 규칙
- `src/` 의 `.luau` 만 수정한다. 새 모듈은 해당 폴더에 파일로 만든다. `.rbxl`·`default.project.json`·`rokit.toml` 은 건드리지 않는다 (필요하면 매니저에게 요청).
- 모든 파일은 strict (`.luaurc`). `--!nonstrict`·`any` 로 오류를 숨기지 않는다.
- 끝내기 전에 `node "${CLAUDE_PLUGIN_ROOT}/tools/roblox-check/check.js" <worktree 이름>` 을 직접 실행해 종료 코드 0 을 확인한다 (0 통과 / 1 실패 / 2 검사 불가).
- 엔진이 필요 없는 로직(계산·상태 머신·데이터 변환)은 순수 모듈로 분리하고 Lune 테스트를 같이 만든다 (`tests/*.spec.luau`, `lune run <파일>`).
- 서버 권한 원칙: 클라이언트 입력은 RemoteEvent 로 받고 서버에서 검증한다. 클라이언트가 보낸 값을 그대로 믿지 않는다.

## 게이트 (roblox-check, 세부: `${CLAUDE_PLUGIN_ROOT}/tools/roblox-check/README.md`)
```
node check.js <worktree 경로|이름>        # 검사 (이름이면 <main>-wt/<이름>)
node check.js new <이름> [--no-gate]      # 브랜치 feature/<이름> + worktree + Stop 훅 완료 게이트
node check.js remove <이름> [--force]     # worktree + 브랜치 삭제
```
- main 폴더는 현재 폴더(또는 인자로 준 경로)가 속한 git 저장소에서 찾는다. 다른 곳에서 부르면 `ROBLOX_CHECK_MAIN` 으로 지정한다.
- 내용: rojo sourcemap(임시 폴더) → `luau-lsp analyze`(strict 타입) → `selene` → `stylua --check`. Studio 없이 5초 안팎.
- 비교 기준 브랜치는 main → 없으면 master. `ROBLOX_CHECK_BASE` 로 바꿀 수 있다.
- 브랜치에서 `default.project.json`·`rokit.toml`·`*.rbxl` 이 바뀌면 종료 2 ("main 에서 하라").
- 완료 게이트: 실패하면 exit 2 로 워커가 끝내지 못하게 막는다. 변경이 없으면 건너뛰고, 연속 3회 실패하면 `gave_up` 으로 끝내게 둔다 (unity-check 와 같다).
- 결과: `%TEMP%/roblox-check/gate/<이름>-*/result.json` (Mac `$TMPDIR`) → `result` 가 pass 가 아니거나 `gave_up` 이면 워커 보고를 믿지 않는다.
- 게이트 훅은 worktree 를 만들 때의 플러그인 경로를 적어 둔다. 플러그인을 업데이트했으면 진행 중인 worktree 는 `remove` 뒤 `new` 로 다시 만든다.

## 심볼 탐색
(브리프에도 넣는다)
- grep 대신 **lsp-relay MCP**(`refs`/`defs`/`outline`, 여러 심볼을 한 번에)를 먼저 쓴다. 항상 `project: "<프로젝트>"` (luau-lsp). CLI: `node "${CLAUDE_PLUGIN_ROOT}/tools/lsp-relay/cli.js" <도구> ... --project <프로젝트>`. grep 은 문자열·주석 검색에만.
- 심볼 표기 (모듈 = Rojo 모듈 이름: 파일 이름, `init.*` 면 폴더 이름):
  - `Module` — 모듈 테이블 (참조는 require 줄과 사용처)
  - `Module.member` — 모듈 함수·필드·최상위 local/type (예: `Util.add`, `Obj.greet` = `Obj:greet`)
  - `폴더.Module.member` (예: `shared.Util.add`) — 같은 이름 모듈을 좁힐 때
  - `src/shared/Util.luau:add`, 이름만(`add`), `add@client`(경로 일부)
- `outline` 은 .luau 최상위 함수·변수·타입. 경로는 프로젝트 루트 기준(`src/...`).
- 첫 질의 약 5초(정의 파일 로드), 이후 수십 ms. 파일 수정·추가·삭제는 다음 질의에 자동 반영 (sourcemap 은 데몬이 임시 폴더에 다시 만든다).
- `return function() ... end` 처럼 모듈 변수가 없는 모듈은 refs 에 require 줄만 나온다 → 받은 변수 이름으로 다시 질의.
- 동시 실행 상한 2. 고정(`pinned`)하지 않은 프로젝트는 30분 쉬면 내려가고 다음 질의 때 다시 뜬다. 주 작업 프로젝트는 고정을 사용자에게 제안한다 (`cli.js workspace <root> --lang luau --pinned`).

## 검증 (매니저)
1. 브랜치: 위 게이트를 매니저가 다시 실행해 0 확인.
2. main 병합 후: `rojo serve` 가 켜진 Studio 에 코드가 반영됐는지 확인.
   - 켜기: 프로젝트 루트에서 `rojo serve default.project.json` (백그라운드, localhost:34872). Studio Rojo 플러그인이 서버를 감지해 오른쪽 아래에 "Would you like to connect?" 알림 → **Connect** → 동기화 미리보기 → **Accept**.
   - 미리보기에서 코드 폴더(Shared·Server·Client) 외에 Workspace 등이 바뀌면 Abort 하고 project.json 을 확인한다.
   - 연결 뒤에는 파일 추가·삭제·수정이 1~3초 안에 Studio 에 반영된다.
   - 동기화된 스크립트는 저장 전까지 `.rbxl` 에 안 들어간다. 저장해도 다음 동기화에서 파일 기준으로 덮어쓰므로 문제없다.
   - serve 는 띄운 세션의 백그라운드 작업이라 그 세션이 끝나면 꺼진다. 매니저 세션을 새로 열면 다시 띄우고 다시 Connect 한다.
3. 플레이 검증: Studio MCP 로 아래 순서. 결과는 콘솔의 마커 줄(`[기능명] ok`)과 오류 0 으로 판정한다.
   `list_roblox_studios`(studio_id 확보, 모든 호출에 필요) → `get_studio_state` → `start_stop_play`(시작) → 필요하면 `character_navigation`·`user_keyboard_input`·`user_mouse_input` → `get_console_output` → 필요하면 `screen_capture` → `start_stop_play`(중지).
4. 손맛·연출은 사용자에게 확인을 요청한다.

## Studio MCP (Studio 내장)
- 등록: Claude Code 사용자 범위 `Roblox_Studio` — Windows `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat` (Studio 업데이트로 버전 폴더가 바뀌어도 mcp.bat 이 찾아 줌). Mac 은 `/game-harness:harness-setup` 의 안내를 따른다.
- Studio 쪽 스위치: 오른쪽 위 공유 버튼 옆 **고리 모양 아이콘(AI 어시스턴트)** → 패널 오른쪽 위 **…** → **설정** → **MCP 서버** 탭 → **Studio를 MCP 서버로 사용** (한국어 UI 기준. 영어 UI 는 Assistant → … → Manage MCP Servers → "Enable Studio as MCP server"). 메뉴·리본에는 없다. 아이콘을 누르면 패널이 열고 닫힌다.
  - 꺼져 있으면 프록시가 "Timed out waiting for tools" 로 도구 0개. Studio 를 다시 켜면 꺼져 있을 수 있다 → **도구가 0개면 먼저 이 스위치를 확인**한다 (computer-use 가 있으면 매니저가 켠다).
  - 켜면 다시 시작 없이 바로 도구가 잡힌다. 단 Claude Code 세션은 시작할 때 MCP 를 붙이므로 이미 열린 세션에는 안 생긴다 → 새 세션에서 쓴다.
  - 빠른 확인: `claude mcp get Roblox_Studio` → `✔ Connected` 면 정상, `Connected · tools fetch failed` 면 스위치가 꺼져 있거나 Studio 가 안 떠 있음.
- 도구 (Studio 버전에 따라 다를 수 있다):
  | 분류 | 도구 |
  | :- | :- |
  | 스크립트 | `script_read`, `multi_edit`, `script_search`, `script_grep` |
  | 데이터 모델 | `search_game_tree`, `inspect_instance`, `subagent`(explore/playtest) |
  | Luau | `execute_luau` (Edit / Client / Server 컨텍스트) |
  | 플레이 | `get_studio_state`, `start_stop_play`, `get_console_output`, `screen_capture` |
  | 입력 | `character_navigation`, `user_keyboard_input`, `user_mouse_input` |
  | 에셋 | `generate_mesh`, `generate_material`, `generate_texture`, `segment_mesh`, `generate_procedural_model`, `wait_job_finished`, `search_asset`, `insert_asset`, `upload_image`, `store_image` |
  | 문서 | `http_get`, `skill` |
  | 세션 | `list_roblox_studios` |
- 호출 요령:
  - `studio_id` 는 UUID 문자열, 모든 호출에 필수. Studio 를 다시 열면 바뀔 수 있으니 세션마다 `list_roblox_studios` 로 다시 받는다.
  - `datamodel_type`: `search_game_tree`·`execute_luau` 는 Edit/Client/Server (플레이 중엔 Edit 거부). 입력 도구 3종은 Client 만.
  - `start_stop_play` 는 바로 돌아온다. **시작 직후 첫 `screen_capture` 는 흰 화면** → 몇 초 뒤 다시 찍는다. `screen_capture` 는 `capture_id`(예: `ScreenCapture_1`) 필수.
  - `character_navigation` 은 `x,y,z` 또는 `instance_path`, 반환은 "Success" 뿐 → 위치는 `execute_luau`(Client)로 확인.
  - `execute_luau` 는 첫 반환값만 돌려준다 → 여러 값은 문자열·테이블 하나로 묶어 반환.
  - `get_console_output` 은 전체 로그를 매번 돌려주고 지우는 방법이 없다. 엔진 잡음(`UIBlox - Warning: FoundationProvider not found`, `ContentId ... Asset type does not match` 등)은 걸러서 판정한다. 게임 판정은 마커 줄(`[기능명] ok`)로.
  - `inspect_instance` 경로는 점 표기(`Workspace.Baseplate`).
- **실행 중 게임 조작은 디버그 브리지로**: Studio 명령창·`execute_luau` 에서 `require(모듈)` 하면 실행 중 게임과 **다른 모듈 사본**이 생겨 상태가 비어 보인다. 프로젝트에 Studio 전용 `ServerStorage.DebugBridge`(BindableFunction, `RunService:IsStudio()` 일 때만 생성)를 두고 `execute_luau`(Server)로 `game.ServerStorage.DebugBridge:Invoke("명령", 인자)` 를 부른다. 새 기능 태스크마다 워커가 확인용 명령을 브리지에 추가하게 브리프에 넣는다.
  - 출력 확인은 `get_console_output` 또는 Studio 로그 파일(Windows `%LOCALAPPDATA%\Roblox\logs\*Studio*_last.log` 의 `FLog::CreatorOutput` 줄)로.
  - computer-use 로 플레이 버튼을 누를 땐 첫 클릭이 창 포커스로만 먹을 수 있다 → 플레이 상태를 캡처로 확인. MCP 가 있으면 `start_stop_play` 를 쓴다.
- 사용 규칙:
  - **코드는 MCP 로 고치지 않는다.** `multi_edit` 은 Rojo 원본(`src/`)을 우회해 Studio 안 스크립트만 바꾸므로 금지. 코드 수정은 항상 파일 → Rojo 동기화. `script_read`·`script_grep` 은 동기화 확인용으로만.
  - 월드 작업(`insert_asset`, `generate_*`, `execute_luau` 로 파트 배치)은 main Studio 에서만 하고, 끝나면 사용자에게 `.rbxl` 저장을 요청한다 (MCP 로는 저장 도구가 없음).
  - `execute_luau` 는 검증용 조회·월드 배치에 쓴다. 게임 로직을 여기에만 넣지 않는다.
  - 에셋 생성·업로드(`generate_mesh`, `generate_texture`, `upload_image` 등)는 계정에 결과가 남으므로 사용자 확인 후에만. `generate_texture` 는 원본을 그 자리에서 바꾸므로 더 주의.
  - 구현 워커는 Studio MCP 를 쓰지 않는다 (Studio 1개 = main). 플레이 검증·월드 작업은 매니저 몫이다. 매니저 세션이 MCP 등록 전에 시작돼 도구가 없으면, 검증 전용 세션(Sonnet high, 읽기·플레이만 허용)을 띄워 맡긴다.

## 병렬 제약
- 코드 작성·게이트는 worktree 에서 병렬 가능 (Studio 불필요).
- Studio 를 쓰는 검증·월드 작업은 main 에서 한 번에 하나만.

## 처음부터 L2
- 클라이언트·서버 동기화(RemoteEvent/RemoteFunction 설계), DataStore 저장·마이그레이션.

## 나중 후보
- Open Cloud Luau Execution 으로 게시된 플레이스에서 헤드리스 테스트 (API 키는 사용자가 직접 환경변수로 넣는다. 매니저·워커는 키를 입력하지 않는다).
