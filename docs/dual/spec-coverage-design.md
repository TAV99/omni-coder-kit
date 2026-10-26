# Dual: decision coverage trước implementation

Trạng thái: đề xuất thiết kế để review; chưa triển khai. Phạm vi phase này chỉ là tài liệu này.

## Vấn đề và giới hạn bảo đảm

TASK-BOOKING-DEMO-V2/V3/V4 cho thấy scout có thể hỏi các câu khác nhau qua mỗi lần chạy. Review/QC xác minh đúng pinned spec vẫn có thể trả `TASK_VERIFIED` khi worker tự chọn giờ hoạt động, thời lượng slot, duplicate policy hoặc service catalog khác mong muốn người dùng. Đây là thiếu coverage của quyết định sản phẩm, không phải lỗi chạy harness.

Mục tiêu: mỗi dimension trong catalog áp dụng phải có quyết định có nguồn, được đánh dấu không áp dụng có lý do, hoặc được người dùng giao rõ cho worker. Không hứa suy ra mọi kỳ vọng chưa nói ra: catalog vẫn có thể thiếu dimension. Scout phải được phép đề xuất dimension mới, và báo cáo completion phải phân biệt “đúng contract đã duyệt” với “đã biết toàn bộ ý định người dùng”.

## Cơ sở từ repo

- `templates/workflows/requirement-analysis.md` trích sáu slots, giới hạn interview 1/3/5 câu. Headless guard hiện yêu cầu bỏ interview và ghi reasonable assumptions vào `.omni/sdlc/design-spec.md`. Assumption như vậy chưa phải user approval. Workflow còn có các câu hỏi bổ sung ở completeness/content gates; implementation cần thống nhất chúng với policy mới, tránh tiếp tục hai quy tắc trái nhau.
- `templates/workflows/task-planning.md` tạo `.omni/sdlc/todo.md` và `.omni/sdlc/dual-plan.json`; có thể plan trực tiếp khi không có think. Checkout này không có thư mục `plans/`, và `plans/plan.md` không phải authoritative hook hiện tại.
- `lib/dual/contracts.js`: `DualPlanManifestSchema` hiện là strict schema version 1; `DualPlanTaskSchema`, `ContextSchema` và `SpecSchema` chưa có coverage contract. `ContextSchema.open_questions` là array string, không phải registry decision IDs. `SpecSchema` chủ yếu pin goal, files, commands, risks và authority.
- `lib/dual/orchestrator.js`: `spec` kiểm tra `spec.json` tại `SCOUT_VALID` rồi chuyển `SPEC_VALID`; route dẫn đến `ROUTED` hoặc `CODEX_OWNED`; implement yêu cầu `ROUTED`. Chưa có completeness gate.
- `lib/dual/isolated-runner.js` chạy scout, đọc `open_questions`, trả `NEEDS_CONTEXT` nếu thiếu `controllerReplies`, ghi immutable `controller-context.json`, rồi gọi `orchestrator.run()`. Spec đã được ghi trước scout; không thể coi sửa spec sau câu trả lời là hook an toàn sẵn có.
- `lib/dual/orchestrator-adapter.js` tạo/đối chiếu spec với task đã register. `lib/dual/daemon-server.js` có `handlePlanRegister`, `handleSessionResume`, kiểm tra correlation khi QC; `lib/dual/authority-store.js` lưu/derive authority events. `lib/dual/task-scheduler.js:taskReadiness` hiện chỉ xét dependency và scope. Các hook dưới đây là bổ sung, không phải API đã tồn tại.

## Quyết định 1: catalog chung, một coverage artifact authoritative

Chọn kết hợp think → plan → scout → runtime gate. Think phát hiện sớm; plan vẫn tạo checklist nếu bỏ think; scout đối chiếu repository và phát hiện thiếu sót; runtime mới có quyền chặn. Chỉ gắn vào một prompt sẽ bị bypass khi người dùng vào pipeline từ bước khác.

Đề xuất thêm `templates/spec-coverage/catalog.v1.json`, gồm core và extensions có IDs ổn định, nhãn, hướng dẫn trả lời, ví dụ và `value_schema` cho từng dimension. Thêm `lib/dual/spec-coverage.js` để expand catalog, validate và tính gate; JSON Schema mô tả values, Zod trong `contracts.js` kiểm tra envelope và cross-field invariants. Không dùng Markdown parser làm authority.

Catalog tối thiểu:

| Nhóm | Dimensions bắt buộc xem xét riêng |
| --- | --- |
| Core | `data.entities`, `data.fields` (type, required, identity, defaults); `validation.rules`; `duplicates.policy` (key, scope, normalization, race behavior); `workflow.statuses`, `workflow.transitions`; `actions.create`, `actions.read`, `actions.edit`, `actions.delete`, `actions.cancel`, `actions.date_filter`; `catalog.items`; `storage.persistence` (backend, lifetime, reload, multi-client); `errors.messages`, `errors.language`; `ui.copy` (labels, empty/success states, content source) |
| Booking | `booking.hours` (days, timezone, windows, breaks); `booking.slots` (fixed list hay generated, duration, step, boundary); `booking.capacity` (resource, overlap, concurrent claims); `booking.date_policy` (past dates, horizon); `booking.services` (approved IDs/names/durations); `booking.cancel_policy` (effects on status/capacity) |
| CRUD/task tracker | ownership/visibility, list ordering, search/filter ngoài date, archive/restore, pagination |
| Commerce | currency/price source, inventory/reservation, checkout/payment boundaries, refund policy; delegation không cấp quyền trả tiền hoặc external write |
| Content/landing | approved facts/assets, CTA destination/action, forms và submission destination |
| API/service | request/response contracts, auth/authorization, idempotency, pagination, error codes |

Core áp dụng cả API-only: `ui.copy` có thể `not_applicable`, nhưng phải có lý do. Booking có cả duplicate policy lẫn capacity: cùng khách đặt trùng và hai khách chiếm cùng resource là hai quyết định khác nhau. `catalog.items` có thể tham chiếu cùng quyết định với `booking.services`, không chứa hai giá trị mâu thuẫn.

Mỗi action là dimension riêng với value `{ "enabled": false }` hoặc `{ "enabled": true, "behavior": "..." }`. “Không delete” không suy ra “không edit”, “không cancel” hay “không date filter”. Slots phải có duration và step riêng; không suy ra 60 phút từ một ví dụ. Service names do worker đề xuất chỉ là proposal, không phải catalog đã approved.

App types là multi-select, ghi bằng chứng phân loại. Chưa rõ loại → core + dimension `classification.app_types` unresolved; gate chặn đến khi chọn extension hoặc duyệt custom type với lý do. Không âm thầm fallback booking thành generic CRUD. Có thể thêm custom IDs với cùng schema; engine kiểm tra catalog IDs bắt buộc, không chỉ kiểm tra các rows mà model đã xuất. Không cam kết tự động phát hiện phân loại cố tình sai; bảng approval hiển thị types/extensions và exclusions.

### Data shape đề xuất (chưa tồn tại)

Think/plan tạo `.omni/sdlc/spec-coverage.json`; design-spec có bảng Markdown được render từ artifact và link tới artifact. Artifact cấp project chứa tất cả dimensions; task chỉ tham chiếu subset, không tạo quyết định sản phẩm độc lập.

```json
{
  "schema_version": 1,
  "catalog_version": 1,
  "revision": 1,
  "app_types": ["booking"],
  "classification_sources": ["user-request:initial"],
  "dimensions": [
    {
      "id": "booking.hours",
      "state": "unresolved",
      "proposal": {"timezone": "Asia/Ho_Chi_Minh", "windows": ["08:00-20:00"]},
      "sources": [],
      "reason": "Chưa có yêu cầu xác nhận giờ hoạt động"
    },
    {
      "id": "actions.delete",
      "state": "pinned",
      "value": {"enabled": false},
      "sources": [{"kind": "user", "ref": "user-request:initial", "excerpt": "Không xóa booking"}]
    },
    {
      "id": "ui.copy",
      "state": "delegated",
      "constraints": ["Tiếng Việt", "Không đổi tên service đã pin"],
      "sources": [{"kind": "user", "ref": "coverage-approval:1"}]
    }
  ]
}
```

Union states:

- `unresolved`: thiếu quyết định, có thể có `proposal`; proposal/default không tính coverage.
- `pinned`: bắt buộc `value` đúng dimension schema và sources. Source là user instruction/approval hoặc repository convention có path, section và digest, được hiển thị để duyệt; convention xung đột yêu cầu user không được tự thắng.
- `delegated`: có constraints và source của explicit user authorization; không nhận model self-approval. User có thể chọn nhiều IDs một lần, receipt lưu từng ID. Không chấp nhận wildcard bao gồm dimensions tương lai.
- `not_applicable`: có reason và source; không được dùng để né một chức năng mà user đã yêu cầu.

Reject duplicate/missing IDs, unknown catalog version, invalid values, source conflict chưa xử lý, dependency chưa chốt (ví dụ slots không tương thích hours). Shared decisions chỉ có một value; task không được override. Sources/reference/digest giữ traceability, không tự chứng minh một đoạn prose đúng ý người dùng.

## Quyết định 2: gate blocking, approval một bảng và một lần gửi

Giữ 1/3/5 cho discovery interview; thêm **một approval round tổng hợp**, không phải thêm chuỗi câu hỏi theo dimension. Sau think/plan và scout read-only của các task, controller trình bày toàn bộ unresolved dimensions của plan, proposals, sources, exclusions và types. User trả lời từng row hoặc chọn rõ IDs “worker decides”; có thể sửa cả pinned rows. Nếu mọi dimension đã có quyết định từ user, approval plan có thể đồng thời duyệt coverage digest; không bắt hỏi lại các câu đã trả lời.

Để có một round cho toàn plan, coverage-enabled execution phải có reconnaissance barrier: scout tất cả task trước bất kỳ implementation nào, rồi hợp nhất findings. Đây là orchestration mới; loop scout→implement từng task hiện tại chưa đáp ứng. Dependency cần code chưa được tạo không cản scout coverage: unknown implementation detail thuộc delegation, unknown product behavior vẫn phải xuất hiện. Discovery về sau có thể làm gate stale; không hứa “một round mãi mãi” khi scope thay đổi. Trả lời chưa đủ giữ nguyên bảng pending, không tự mặc định các ô bỏ trống.

Daemon giữ authority/validation, không hỏi qua stdin. Codex controller render qua MCP; CLI render cùng payload cho người dùng terminal. Cần thêm RPC `coverage.inspect` và `coverage.approve` cùng MCP wrappers/CLI commands; không nhét JSON mới vào `context_reply.body` hoặc giả định `session.resume` hiện hiểu coverage. Các scout technical questions hiện có vẫn dùng context mechanism; product questions map sang dimension IDs để tránh hai approvals mâu thuẫn.

### Gate state machine đề xuất

Gate là state riêng, không đổi ý nghĩa các phase states `SCOUT_VALID`, `SPEC_VALID`, `ROUTED`:

| State | Điều kiện / chuyển tiếp | Cho implement? |
| --- | --- | --- |
| `LEGACY_UNCHECKED` | plan v1 không có coverage; warning | Có, theo behavior cũ |
| `DRAFT` | chưa hoàn thành catalog expansion hoặc reconnaissance barrier | Không |
| `AWAITING_APPROVAL` | artifact hợp lệ, hiển thị đủ rows; còn unresolved hoặc chưa có approval receipt | Không |
| `PASSED` | không unresolved; IDs/app types đầy đủ; không conflict; receipt khớp exact artifact/plan/baseline binding | Có |
| `STALE` | input/digest/plan revision/catalog/baseline binding thay đổi hoặc scout phát hiện dimension mới | Không; rebuild → DRAFT/AWAITING_APPROVAL |
| `INVALID` | malformed, missing artifact, invalid reference/hash hoặc schema | Không; sửa input và validate lại |

`coverage.approve` nhận `request_id`, session/workspace identity, plan revision, candidate digest và explicit decisions theo IDs. Server compare-and-set digest; concurrent/stale submission bị reject. Cùng request/content idempotent; cùng ID khác content reject. Chỉ transition PASSED khi toàn bộ quyết định hợp lệ; có thể lưu draft trả lời thiếu nhưng không phát receipt thành công. Receipt immutable ghi actor/source user authorization, timestamp, catalog/version, coverage digest, plan revision, task IDs và baseline identity. Controller không được tự nhận là user; approval phải dựa trên thông điệp user hoặc preapproval artifact có nguồn đã cấp, như authority boundary hiện tại, không phải worker text.

Plan registration được phép ở DRAFT để chạy scout; chưa cho execution authority để sửa source. Gate kiểm tra ở dispatch và ngay trước launch/resume/retry implementation, cả shared/isolated và Codex-owned path. Lease scout có thể tồn tại nhưng không được chuyển thành writable lease nếu chưa PASSED. Legacy direct `runPhase('implement')` cũng phải gọi cùng evaluator; không chỉ chặn trong UI/scheduler. Cached phase success không cho reuse nếu coverage binding khác.

Không sửa registered task scope/spec tại chỗ sau approval: coverage receipt là immutable sidecar bound với plan/spec; thêm reference ở schema mới. Nếu answer thay goal/files/commands/scope, phải lập plan revision/session mới qua cơ chế registration hợp lệ; không giả định daemon hỗ trợ hot mutation của plan active. Đang chạy mà phát hiện stale: dừng dispatch mới, dừng worker theo lifecycle hiện tại, giữ evidence, không integration trước reapproval/revalidation.

### Headless và auto mode

Headless vẫn tạo proposals và pending report, nhưng không biến assumptions thành pinned/delegated. Có receipt/preapproval với explicit values hoặc danh sách delegated IDs đúng binding → gate có thể pass không cần stdin. Không có → trả trạng thái non-success có cấu trúc `SPEC_COVERAGE_REQUIRED`, artifact/report paths và pending IDs, giải phóng execution lease an toàn; không treo chờ và không launch implement. Auto mode dừng ở đây vì thiếu product authority. Không có `--yes` ngầm delegate toàn bộ; automation phải cung cấp decision file/preapproval rõ ràng. Safety, paid actions, external grants và scope guard vẫn độc lập, không được coverage approval thay thế.

### Review, QC và delegated decisions

Implement nhận coverage + receipt như immutable inputs. Với mỗi delegated dimension đã dùng, worker xuất `decision_log` sidecar `{dimension_id, chosen_value, rationale, evidence_refs}` theo value schema. Không được chọn ngoài constraints hoặc tự quyết một unresolved/new product dimension; phát hiện mới phải trả NEEDS_CONTEXT và làm gate stale trước khi tiếp tục.

Review/QC đối chiếu implementation với pinned values, N/A exclusions, delegation constraints và decision log. Có thể flag delegated choice nếu vi phạm constraint, mâu thuẫn pinned rule, thiếu evidence hoặc không ghi log. Choice hợp lệ nhưng khác sở thích chưa nói ra được hiển thị advisory, không tự coi là spec violation hay ghi lại như user-approved requirement. Completion report liệt kê delegated choices và legacy coverage status. `TASK_VERIFIED` vẫn là xác minh contract; không phải bảo đảm mọi mong muốn chưa ghi nhận.

## Hooks và files đề xuất cho implementation phase

Tất cả thay đổi bên dưới là tương lai; phase hiện tại không chạm các files này.

| Files | Thay đổi |
| --- | --- |
| Thêm `templates/spec-coverage/catalog.v1.json`, `templates/codex-gemini/schemas/spec-coverage.schema.json`, `lib/dual/spec-coverage.js` | catalog, artifact schema, expansion/evaluator/receipt checks dùng chung |
| `templates/workflows/requirement-analysis.md`, `task-planning.md`, `dual-controller.md` | generate/render coverage; thay headless assumption authority; reconnaissance barrier, approval và delegation policy |
| `lib/dual/contracts.js` | thêm plan manifest v2 (giữ parser v1), coverage binding `{path, sha256, catalog_version}`, task `decision_ids`, schemas gate/events/receipt/log; version spec/context/evidence khi cần, không thêm fields vào strict v1 payload |
| `templates/codex-gemini/prompts/scout.md`, `implement.md`, `review.md`; schemas `context.schema.json`, `evidence.schema.json`, `review.schema.json` | scout reports IDs/proposals, worker decision log, review coverage findings; schema và Zod phải đồng bộ |
| `lib/dual/orchestrator.js`, `orchestrator-adapter.js`, `isolated-runner.js` | split reconnaissance/execution; gate direct implement và retry; immutable coverage inputs/hash collection/correlation |
| `lib/dual/daemon-server.js`, `authority-store.js`, `task-scheduler.js` | inspect/approve handlers, append/derive gate events, barrier/readiness, lease và QC/integration checks; register coverage reference và kiểm tra receipt trước writable execution |
| `lib/dual/daemon-client.js`, `mcp-server.mjs`, `lib/commands/dual.js`, `bin/omni.js` | transport/tool/CLI mới, pending table và headless structured result; runtime enforcement vẫn ở daemon/orchestrator |
| `lib/dual/isolated-qc.js`, `task-integration.js`, `acceptance-policy.js` | nối binding/log vào verification/integration và acceptance evidence, tránh đường QC bypass |
| Tests dưới `test/` | contract compatibility, gate transitions, dispatch bypass/retry, headless, digest races, booking fixtures |

Không tạo `plans/plan.md` để làm source authority mới. Nếu cần bản plan Markdown cho người đọc, dùng output hiện tại; JSON và receipt mới là inputs được hash và kiểm tra.

## Backwards compatibility và rollout

1. Thêm dual-read v1/v2; plan v1 đang tồn tại tiếp tục chạy, không rewrite artifact hoặc authority journal. Status báo `LEGACY_UNCHECKED`, không báo coverage complete. Replay event cũ phải giữ nguyên semantics.
2. Sau khi runtime và templates/schema được phát hành đồng bộ, generator mới mặc định emit v2 có coverage. V2 thiếu file/ref không được downgrade thành legacy. Binary cũ reject v2 rõ ràng thay vì bỏ qua gate.
3. Migration opt-in: đọc plan/spec cũ và user sources, tạo candidate coverage, đánh dấu assumptions unresolved, scout rồi approval. Chỉ chạy revision/session mới khi không có active writable lease; không mutate run đang chạy và không biến kết quả TASK_VERIFIED cũ thành coverage-certified.
4. Catalog version pin theo plan; catalog upgrade chỉ áp dụng cho plan mới/migration có chủ ý. Không buộc reapprove mọi run cũ khi thêm dimension vào catalog.

Trade-off: compatibility cố ý để lại gap cho legacy tasks. Warning-only chỉ dành cho đường legacy, không phải escape hatch cho plan coverage-enabled.

## Các phương án đã tranh luận và bác bỏ

- **Chỉ tăng budget 1/3/5:** dễ làm, hỏi sâu hơn; vẫn không chứng minh đã xét dimension không xuất hiện trong prompt, và headless vẫn bỏ interview. Giữ budget discovery, thêm coverage approval riêng.
- **Bắt scout hỏi một fixed list:** tăng tính ổn định cho booking, nhưng gây lặp câu đã có nguồn, không thích hợp API/content và vẫn chỉ là prompt compliance. Chọn catalog IDs chung + extensions, hỏi phần thiếu và runtime kiểm tra tập IDs.
- **Checklist chỉ trong design-spec hoặc plan prose:** review dễ đọc nhưng không chặn được bỏ think, bỏ row, drift hoặc direct phase launch. Chọn JSON authoritative, Markdown render.
- **Warning-only gate cho mọi plan:** giữ tốc độ automation nhưng tái tạo đúng failure mode worker invention rồi TASK_VERIFIED. Chọn blocking cho v2; delegation rõ ràng giữ khả năng tự chủ có kiểm soát.
- **Review suy đoán kỳ vọng chưa ghi ra:** có thể phát hiện UX lạ, nhưng không có oracle để phân biệt bug với lựa chọn hợp lệ; còn phát sinh rework sau implementation. Review có thể advisory hoặc yêu cầu clarification mới, không kết tội một unstated preference.

## Không xây trong phạm vi này

- Không xây universal ontology hay catalog đầy đủ cho mọi ngành. Bắt đầu core + các extensions trên; unknown domain phải có custom decisions rõ ràng.
- Không tự generate toàn bộ acceptance tests từ prose. Coverage nói quyết định nào đã được chốt; tests/QC vẫn cần kiểm chứng hành vi.
- Không thêm interview loop trong implementation, không rewrite harness/process isolation, không thay grants/security policy, không sửa booking demos để “chứng minh” thiết kế.
- Không ngầm nâng version package, commit/push, migrate active tasks hay tự cài dependencies. Implementation và rollout là phase sau.

## Acceptance cho phase triển khai sau

- Booking fixture không nói hours/slots/duplicates/services/actions: mỗi ID thiếu xuất hiện ổn định ở report dù scout wording khác; không có writable launch.
- Pin fixed windows `08:00-12:00`, `13:30-17:30` và duration 60: implementation tùy ý dùng `08:00-20:00` hoặc arbitrary duration bị review/QC flag. No-delete vẫn cần quyết định riêng edit/cancel/date-filter.
- Approval rõ delegated IDs: gate pass, worker ghi choices, hợp lệ trong constraints thì không bị fail vì preference chưa nói; vượt constraints thì fail.
- Headless không approval trả report và non-success; có preapproval hợp lệ chạy được. Missing/changed hashes, partial responses, new dimension, direct implement/retry/resume không bypass gate.
- V1 fixture chạy như trước có warning; v2 malformed không downgrade; stale/concurrent approval và artifact tampering bị reject; correction/integration không reuse coverage evidence cũ.

## Câu hỏi còn cần người dùng quyết định

Các mục trên là phương án thiết kế đã chọn trong đề xuất, chưa phải phê duyệt triển khai. Các câu hỏi còn mở không được dùng làm implicit defaults:

1. Phạm vi release đầu: triển khai tất cả extensions liệt kê hay chỉ core + booking trước? Khuyến nghị core + booking để kiểm chứng bằng regression thực tế; extension khác là backlog có cùng contract.
2. Headless approval provenance cần mức trust nào: decision file có user-supplied provenance theo mô hình controller hiện tại, hay bắt buộc receipt do interactive session đã cấp? Khuyến nghị receipt đã cấp cho CI; nếu chấp nhận decision file trực tiếp cần xác định ai được cấp authority để tránh controller tự ký assumptions.
3. Chấp nhận chi phí scout toàn graph trước một approval round, hay muốn gate theo task với nhiều lần approval? Khuyến nghị barrier toàn graph theo yêu cầu một round; graph lớn sẽ tăng latency và cần invalidate reconnaissance khi dependency làm context thay đổi.
