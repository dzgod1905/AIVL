# PROMPT CHO CLAUDE CODE — Workflow Builder + AI Multi-Agent System

> Copy toàn bộ file này, paste vào Claude Code (hoặc để ở root repo rồi bảo Claude Code đọc).
> Đây là repo đã tồn tại trên GitHub. **Không tạo repo mới**, chỉ scaffold thêm các folder bên dưới.

---

## 0. CÁCH LÀM VIỆC (đọc trước khi code)

1. Đọc hết spec này, xác nhận lại kế hoạch với tôi bằng 1 checklist ngắn TRƯỚC khi viết code.
2. Xây theo thứ tự để verify được từng bước:
   `contracts` → `automation-server` (dummy đơn giản nhất) → `ai-multi-agent` (agents rồi orchestrator) → `web` → `docker-compose` → seed data + demo.
3. Sau mỗi service, chạy thử và cho tôi lệnh để tự test (curl / trang UI).
4. Ưu tiên code chạy được và dễ đọc hơn là tối ưu sớm. Đây là PoC.
5. Viết `README.md` ở root: cách chạy local, biến môi trường, và 1 workflow demo end-to-end.

---

## 1. MỤC TIÊU

Một hệ thống PoC cho phép user **tạo & chạy workflow nhiều step**. Mỗi step là một
AI agent hoặc một automation tool, lấy từ **catalog động** tổng hợp từ 2 hệ thống khác.
Orchestrator điều phối để nhiều workflow chạy song song, tự giao việc cho agent đang rảnh,
và hỗ trợ tạm dừng chờ con người ("human-in-the-loop"). Workflow là **đồ thị phụ thuộc**:
mỗi step có thể `dependsOn` nhiều step trước, nên trong cùng 1 workflow các step độc lập
được **chạy song song** (vd Verification và Report cùng chạy sau Execution).

## 2. TECH STACK (đã chốt — không tự đổi)

| Phần | Stack |
|------|-------|
| web | Next.js (App Router, TypeScript) + Neon Postgres (dùng Drizzle ORM) + deploy Vercel |
| ai-multi-agent | Python + FastAPI + **Celery + Redis** (điều phối việc) + SQLite (local, lưu IO từng step dạng JSON) |
| automation-server | Python + FastAPI (dummy) |
| contracts | OpenAPI (`openapi.yaml`) làm nguồn chân lý; generate type cho web (TS) và pydantic (Python) |
| realtime → web | **SSE** (Server-Sent Events) đẩy trạng thái run + tín hiệu pause xuống trình duyệt |

Dùng `uv` cho môi trường Python (2 service Python có `pyproject.toml` riêng).

## 3. CẤU TRÚC REPO (1 repo, các folder riêng)

```
<repo>/
├── contracts/
│   └── openapi.yaml          # NGUỒN CHÂN LÝ cho mọi API giữa các service
├── web/                      # Next.js — Vercel Root Directory = "web"
├── ai-multi-agent/           # GÓI TOÀN BỘ hệ multi-agent trong 1 folder
│   ├── shared/               # celery app, redis config, sqlite db, http clients, schemas
│   ├── agents/               # 6 dummy agent (ngang hàng, KHÔNG nằm trong orchestrator)
│   │   ├── base.py
│   │   ├── parser.py
│   │   ├── planner.py
│   │   ├── execution.py
│   │   ├── verification.py
│   │   ├── report.py
│   │   └── self_healing.py
│   ├── orchestrator/         # AGENT ĐIỀU PHỐI — ngang hàng với 6 agent trên,
│   │   │                     # KHÔNG chứa chúng, chỉ điều phối chúng
│   │   ├── app.py            # FastAPI surface
│   │   └── engine.py         # state machine + dispatch loop
│   └── pyproject.toml
├── automation-server/        # FastAPI dummy
│   └── pyproject.toml
├── docker-compose.yml        # redis + ai-multi-agent (api + workers) + automation-server
└── README.md
```

> **Quan trọng về mặt khái niệm:** orchestrator *bản thân nó là một agent* mang vai trò
> điều phối. Nó không phải là "cha" của 6 agent kia; cả 7 là peer, dùng chung `shared/`.
> orchestrator không domain-work, việc của nó là: quyết step tiếp theo, đẩy task cho agent
> rảnh qua queue, theo dõi trạng thái, lưu IO, và xử lý pause/resume.

## 4. CONTRACT CHUNG (`contracts/openapi.yaml`)

Cả `ai-multi-agent` và `automation-server` PHẢI expose cùng bộ endpoint "catalog + invoke"
để web coi agent và automation tool là **giống hệt nhau** khi thêm vào step:

```
GET  /catalog
  -> 200 [{ id, name, type: "ai_agent" | "automation_tool",
            description, inputSchema, outputSchema, configurable: bool }]

POST /invoke
  body { unitId, input: object, config?: object }
  -> 200 { runId }

GET  /invoke/{runId}
  -> 200 { status: "queued"|"running"|"done"|"failed", input, output, done: bool }

GET  /health -> 200 { ok: true }
```

Riêng `ai-multi-agent` (orchestrator) có thêm các endpoint điều phối workflow ở mục 6.

Sinh type từ file này: `openapi-typescript` cho web, pydantic models cho Python
(FastAPI vốn tự sinh OpenAPI của nó, nhưng phần contract dùng chung thì lấy từ đây).

## 5. WEB (`web/`)

Next.js App Router + Drizzle + Neon. Deploy Vercel với Root Directory = `web`.

**Tính năng:**

1. **Builder page** (`/builder`): tạo workflow gồm nhiều step, có thể **nối tiếp hoặc
   phân nhánh/song song** (quan hệ phụ thuộc qua `dependsOn`).
   - Nút "Add step" mở picker chọn 1 unit từ catalog tổng hợp.
   - Catalog lấy qua route `GET /api/catalog` — route này gọi **song song**
     `ai-multi-agent /catalog` và `automation-server /catalog` rồi gộp lại
     (gắn thêm field `source: "ai" | "automation"`).

2. **Step config** (form mỗi step):
   - `promptTemplate` (chỉ hiện khi `type === "ai_agent"`): textarea hỗ trợ biến
     tham chiếu output step trước dạng `{{<stepKey>.output}}`. Có **dropdown**
     liệt kê output các step đứng trước để chèn nhanh (đừng bắt user tự nhớ tên).
     Ví dụ config Planner: prompt = "Từ `{{parser.output}}`, hãy lập kế hoạch ...".
   - `contextMapping`: map field từ output step trước → input step hiện tại.
   - `apiConfig`: `unitId` + service target để invoke.
   - `dependsOn: string[]` — danh sách `stepKey` mà step này phụ thuộc. Step chỉ chạy khi
     TẤT CẢ step trong `dependsOn` đã `done`. Rỗng = chạy ngay từ đầu. UI cho chọn từ các
     step đã tạo (có thể là multi-select). Đây là thứ định nghĩa nhánh/song song, không phải
     thứ tự hiển thị. **Chặn tạo vòng lặp (cycle)** khi lưu.
   - `humanInvolved: boolean` — bật thì sau khi step này chạy xong sẽ dừng chờ người.
   - `maxAttempts` (mặc định 5) + `timeoutSec` (mặc định 30): giới hạn số lần hỏi lại /
     thời gian chờ 1 step trước khi coi là `failed` (xem mục 6a).

3. **Run workflow**:
   - Bấm "Run" → `POST /api/runs` → web gọi orchestrator `POST /runs`.
   - Web lưu **định nghĩa workflow + metadata run** trong Neon.
   - Chi tiết input/output từng step **KHÔNG lưu ở web** — query qua service từ
     orchestrator (`GET /runs/{id}`). Tránh trùng dữ liệu.

4. **Trang theo dõi run** (`/runs/[id]`):
   - Kết nối **SSE** để cập nhật realtime trạng thái từng step (queued/running/done/paused).
   - Kết nối qua route handler của Next: `GET /api/runs/[id]/events` **proxy stream SSE**
     từ orchestrator xuống browser (giải quyết CORS/auth gọn).

5. **Human-in-the-loop UI**:
   - Khi run rơi vào trạng thái `paused_for_human`, hiện panel show **input & output**
     của step vừa xong (lấy qua service), kèm nút **"Continue"**.
   - "Continue" → `POST /api/runs/{id}/resume` → orchestrator `POST /runs/{id}/resume`.

**Data model (Neon / Drizzle):**
- `workflows(id, name, created_at)`
- `workflow_steps(id, workflow_id, order, step_key, unit_id, unit_type, source, prompt_template, context_mapping jsonb, api_config jsonb, depends_on jsonb, human_involved bool, max_attempts int default 5, timeout_sec int default 30)`
  *(`order` chỉ để hiển thị; `depends_on` = list `step_key` mới là thứ quyết định thứ tự chạy)*
- `workflow_runs(id, workflow_id, orchestrator_run_id, status, created_at)`
  *(chỉ metadata + con trỏ tới run bên orchestrator; KHÔNG lưu IO chi tiết)*

## 6. AI MULTI-AGENT (`ai-multi-agent/`)

### 6a. Orchestrator (agent điều phối) — `orchestrator/`

**FastAPI endpoints:**
```
POST /runs                 body { workflowId, input,
                             steps:[{ stepKey, unitId, unitType, source, promptTemplate,
                                      contextMapping, dependsOn:[stepKey],
                                      humanInvolved, maxAttempts, timeoutSec }] }  -> { runId }
GET  /runs/{id}            -> { status, steps:[{ stepKey, status, input, output, done }] }
POST /runs/{id}/resume     -> tiếp tục sau khi human đã xem
GET  /runs/{id}/events     -> SSE stream các cập nhật trạng thái
GET  /catalog              -> list 6 AI agent (theo contract mục 4)
GET  /agents               -> trạng thái busy/idle từng agent (để quan sát/debug)
```

**engine.py — vòng đời 1 run (state machine):**
- Mỗi run có `status`: `running | paused_for_human | done | failed`.
- Mỗi step có `status`: `pending → running → done | failed`.
- **Chạy song song trong 1 workflow:** một step là *runnable* khi TẤT CẢ step trong
  `dependsOn` của nó đã `done`. Ở mỗi vòng điều phối, tìm **mọi** step runnable (không chỉ 1)
  và dispatch chúng cùng lúc — các nhánh độc lập nhờ đó chạy song song. Run `done` khi mọi
  step `done`; run `failed` ngay khi có 1 step `failed`.
- Với mỗi step runnable:
  1. Dựng input step (áp `contextMapping` + render `promptTemplate` với output các step
     trong `dependsOn`).
  2. **Đẩy 1 Celery task vào queue của đúng agent đó** (`queue:parser`, `queue:planner`, …).
     Không tự viết logic "chọn agent rảnh" — **để Celery/Redis lo phân phối**: worker nào
     rảnh sẽ tự lấy task. Đặt concurrency worker để mô phỏng số instance mỗi agent.
  3. Poll kết quả task. **Xử lý case agent báo chưa xong:** nếu kết quả trả `done=false`,
     orchestrator **hỏi lại** (re-dispatch task đó với `attempt+1`) sau 1 khoảng delay ngắn.
     Log rõ mỗi lần "agent X báo chưa xong, hỏi lại".
     **GIỚI HẠN (bắt buộc):** dừng hỏi lại khi chạm `maxAttempts` (mặc định 5) HOẶC tổng thời
     gian chờ vượt `timeoutSec` (mặc định 30s). Khi đó set step = `failed` (ghi lý do:
     `max_attempts_exceeded` / `timeout`), set run = `failed`, emit SSE. Không loop vô hạn.
  4. Khi step `done`: **lưu input/output step dạng JSON vào SQLite**, emit SSE.
  5. Nếu step đó `human_involved=true`: set run = `paused_for_human`, emit SSE, **DỪNG**
     dispatch (kể cả các nhánh song song khác) cho tới khi có `/resume`.
- Nhiều run chạy song song: engine xử lý theo từng run độc lập; vì việc giao agent do queue
  đảm nhiệm nên các run tự chia sẻ pool worker mà không đụng nhau (không race).

**SQLite (`shared/db.py`, TÁCH BIỆT DB của web):**
- `runs(id, workflow_id, status, created_at)`
- `step_runs(id, run_id, step_key, agent, status, input_json, output_json, attempts, max_attempts, started_at, done, fail_reason)`

### 6b. Sáu dummy agent — `agents/`

Danh sách: **Parser, Planner, Execution, Verification, Report, Self-Healing**
(khớp diagram; đặt trên queue riêng mỗi loại).

- `base.py`: hành vi chung. Mỗi agent là 1 **Celery task**. Khi được invoke, trả về:
  ```json
  { "input": <input nhận được>, "agent": "<tên agent>", "done": <bool> }
  ```
- **Mô phỏng chạy lâu để test:** dựa trên `attempt` (đếm theo run+step, lưu ở Redis/SQLite),
  agent trả `done=false` trong `N` lần đầu (mặc định N=1, cấu hình được), rồi `done=true`.
  Đây chính là case để chứng minh orchestrator hỏi-lại-khi-chưa-xong hoạt động đúng.
- **Chế độ "kẹt" để test timeout:** có cờ cấu hình khiến agent LUÔN trả `done=false`
  (không bao giờ xong). Dùng để kiểm chứng orchestrator cắt ở `maxAttempts`/`timeoutSec`
  và set step/run = `failed` thay vì loop vô hạn.
- 6 file agent kế thừa `base`, chỉ khác `name` + `queue`.

### 6c. Giao tiếp

- `shared/clients.py`: HTTP client gọi `automation-server` (khi 1 step là automation tool,
  orchestrator invoke sang đó theo contract mục 4) và callback về web nếu cần.
- `shared/celery_app.py`: Celery app, broker + backend = Redis, khai báo route queue theo agent.

## 7. AUTOMATION SERVER (`automation-server/`) — DUMMY

FastAPI, theo contract mục 4:
- `GET /catalog` trả list tool (từ 1 bảng/seed): **CAN Adapter, LIN Tool, SOME/IP Ethernet,
  HMI (Touch/Swipe), Battery ON/OFF, USB Control, Screenshot/Record** — mỗi cái
  `type: "automation_tool"`.
- `POST /invoke` + `GET /invoke/{runId}`: dummy, trả `done=true` (có thể delay giả lập).
- Không cần logic thật.

## 8. CÁC LUỒNG CHÍNH (để Claude Code không hiểu sai)

**Luồng A — phân chia việc cho agent (Orchestrator ↔ agents):** qua **Redis + Celery queue**
(pull-based). Orchestrator đẩy task vào queue theo loại agent; worker rảnh tự nhận. Đây là cơ
chế chính giúp nhiều workflow chạy song song mà không cần tự viết scheduler. Song song xảy ra
ở **2 mức**: giữa các workflow khác nhau, VÀ giữa các step độc lập (`dependsOn` đã thoả) trong
cùng 1 workflow — orchestrator cứ đẩy hết step runnable vào queue, Celery lo phần còn lại.

**Luồng B — báo trạng thái (Orchestrator → Web):** qua **SSE**. Web `/runs/[id]` subscribe
để thấy step chạy tới đâu và biết khi nào rơi vào `paused_for_human`.

**Human-in-the-loop:** step `human_involved` chạy xong → run `paused_for_human` → web hiện
input/output + nút Continue → `/resume` → orchestrator dispatch step kế.

## 9. DOCKER-COMPOSE

`docker-compose.yml` chạy local đủ:
- `redis`
- `ai-multi-agent-api` (FastAPI orchestrator, expose port)
- `ai-multi-agent-workers` (Celery workers cho 6 agent; có thể 1 container chạy nhiều queue,
  đặt concurrency > 1 để thấy song song)
- `automation-server` (FastAPI, expose port)
- (web chạy `npm run dev` ngoài compose là được, hoặc thêm service nếu tiện)

`.env.example` cho từng service (DATABASE_URL Neon cho web, REDIS_URL, các base URL service).

## 10. ACCEPTANCE CRITERIA (seed + demo end-to-end)

Seed sẵn workflow demo và chứng minh chạy được:
1. Workflow tuyến tính: **Parser → Planner → Execution**, trong đó **Planner bật
   `human_involved`**.
2. Bấm Run trên web → thấy Parser done, Planner done rồi run **dừng ở `paused_for_human`**,
   web hiện input/output của Planner.
3. Ít nhất 1 agent trả `done=false` một lần rồi mới `done=true`, và log orchestrator cho thấy
   nó đã **hỏi lại** đúng cơ chế.
4. Bấm **Continue** → Execution chạy tiếp → run `done`.
5. Catalog trong builder hiển thị **cả 6 AI agent lẫn các automation tool** (gộp từ 2 service).
6. Chạy 2 workflow cùng lúc → thấy agent được giao song song (qua log/`GET /agents`).
7. **Workflow phân nhánh:** Execution → (Verification, Report cùng `dependsOn: [execution]`)
   → Self-Healing (`dependsOn: [verification, report]`). Chứng minh Verification & Report
   **chạy song song**, và Self-Healing chỉ chạy sau khi cả hai `done`.
8. **Case timeout:** 1 step trỏ tới agent ở **chế độ "kẹt"** → orchestrator hỏi lại tới
   `maxAttempts`/`timeoutSec` rồi set step + run = `failed` với `fail_reason` rõ ràng
   (KHÔNG loop vô hạn).

## 11. NON-GOALS (đừng làm quá tay ở PoC)

- Không cần auth user thật; service-to-service chỉ cần API key đơn giản (hoặc bỏ qua ở local).
- Agent là dummy — **không tích hợp LLM thật**.
- Automation server chỉ trả list + invoke dummy.
- Không cần CI/CD; chỉ cần README chạy local + Vercel deploy cho web.

---

Khi hoàn tất, tóm tắt cho tôi: các lệnh chạy từng service, URL trang builder, và cách chạy workflow demo.
