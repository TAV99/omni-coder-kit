# Skill Search Optimize — Smart Matching Engine

**Date:** 2026-04-27
**Branch:** `feat/skill-search-optimize`
**Approach:** B — Score-based matching + registry v2 + fallback chain + validation

---

## Problem

Nhánh `skill-search-optimize` hiện implement Phase 2 auto-equip (curated test skills theo tech stack). Logic matching có các hạn chế:

1. **Composite framework parsing thiếu:** `"Jest + Playwright"` chỉ match Playwright addon, không tách để match Jest exact
2. **Binary exact/fallback:** Không có scoring — khó mở rộng cho patterns mới
3. **Duplicate entry:** Python xuất hiện 2 lần trong registry (cùng `name`)
4. **Coverage gaps:** Go, Ruby, Java, Mocha không có curated skill — exit im lặng
5. **Không validation:** Registry sai schema chỉ phát hiện khi runtime crash
6. **UX im lặng:** Không phát hiện project hoặc không có skill → không thông báo gì

---

## Design

### 1. Registry Schema v2

**Trước:**
```js
{ source, name, desc, lang: string[], testFramework: string|null }
```

**Sau:**
```js
{
  source: string,
  name: string,
  desc: string,
  lang: string[],
  frameworks: string[],   // [] = generic fallback
  category: 'unit' | 'e2e' | 'integration' | 'generic'
}
```

- `testFramework: string|null` → `frameworks: string[]` — mảng, hỗ trợ multi-framework matching
- `[]` thay thế `null` cho generic skills
- Thêm `category` cho scoring và display grouping

**Registry entries:**

| name | lang | frameworks | category |
|------|------|------------|----------|
| `javascript-typescript-jest` | JS, TS | `['Jest']` | unit |
| `vitest` | JS, TS | `['Vitest']` | unit |
| `mocha-testing` | JS, TS | `['Mocha']` | unit |
| `javascript-testing-patterns` | JS, TS | `[]` | generic |
| `playwright-best-practices` | JS, TS | `['Playwright']` | e2e |
| `python-testing-patterns` | Python | `[]` | generic |
| `rust-best-practices` | Rust | `[]` | generic |
| `php-pro` | PHP | `[]` | generic |

Duplicate Python entry bị xoá. Mocha entry mới được thêm.

### 2. Composite Framework Parser

```js
function parseFrameworks(testField) {
    if (!testField) return [];
    return testField.split(/\s*\+\s*/).map(s => s.trim()).filter(Boolean);
}
```

Tách `techStack.test` thành mảng: `"Jest + Playwright"` → `['Jest', 'Playwright']`.

### 3. Score-based Matching

Mỗi skill được tính điểm:

| Tiêu chí | Điểm | Điều kiện |
|-----------|-------|-----------|
| Language match | +10 | Bắt buộc — nếu không khớp → skip |
| Framework exact match | +5/fw | Mỗi framework trong `frameworks` khớp với detected |
| Category `unit` | +2 | Ưu tiên unit test |
| Category `e2e` | +1 | E2E có giá trị nhưng thấp hơn |
| Category `generic` | +0 | Chỉ chọn khi không có exact |

**Selection rules sau scoring:**
1. Skill có `frameworks` không rỗng nhưng KHÔNG khớp detected → loại hoàn toàn
2. Nếu có ít nhất 1 skill với framework match → loại tất cả generic (`frameworks=[]`)
3. Deduplicate by `name`
4. Sort giảm dần theo score

**Ví dụ:** Stack `{ language: 'TypeScript', test: 'Jest + Playwright' }`

| Skill | Score | Chọn? |
|-------|-------|-------|
| `javascript-typescript-jest` | 10+5+2 = 17 | ✓ |
| `playwright-best-practices` | 10+5+1 = 16 | ✓ |
| `vitest` (fw=['Vitest'], không khớp) | loại | ✗ |
| `mocha-testing` (fw=['Mocha'], không khớp) | loại | ✗ |
| `javascript-testing-patterns` (generic) | loại (có exact) | ✗ |

### 4. Fallback Chain

```
Bậc 1: Curated match (score-based) → có kết quả → cài bình thường
    ↓ rỗng
Bậc 2: Suggest find-skills search keyword → hiển thị cho user
    ↓ user từ chối hoặc bỏ qua
Bậc 3: Exit với thông báo rõ ràng
```

Keyword generation: `buildSearchSuggestion(lang, testFw)` → `"{lang} {fw} testing"`.toLowerCase()

Ví dụ:
- Go + null → `"go testing"`
- Ruby + RSpec → `"ruby rspec testing"`

UX messages cho tất cả scenarios:

| Scenario | Message |
|----------|---------|
| Có curated skills mới | `🧪 Phát hiện tech stack — đề xuất test skills:` |
| Tất cả đã cài | Exit im lặng |
| Không có curated skill | `🔍 Chưa có curated test skill cho {lang}. Gợi ý: npx skills search "{keyword}"` |
| Không detect project | `⚠️ Không phát hiện project — bỏ qua đề xuất test skills.` |
| Không detect language | `ℹ️ Không xác định được ngôn ngữ chính — bỏ qua test skills.` |

### 5. Registry Validation

`validateRegistry(skills)` chạy 1 lần tại `require()` time:
- Check `source`, `name`, `desc` là non-empty string
- Check `lang` là non-empty array
- Check `frameworks` là array
- Check `category` thuộc enum `['unit', 'e2e', 'integration', 'generic']`
- Check không duplicate `name`
- Throw `Error` với message chỉ rõ index nếu vi phạm

### 6. Test Suite Update

~25-28 test cases, tổ chức 4 nhóm:
- **parseFrameworks:** 6 cases (null, empty, single, composite, extra spaces, triple)
- **validateRegistry:** 6 cases (valid, missing fields, wrong types, duplicate name)
- **getTestSkillsForStack:** 14 cases (all language/framework combinations + edge cases; Python returns generic match regardless of pytest detection)
- **buildSearchSuggestion:** 3 cases (lang only, lang+fw, lowercase)

Giữ `node:test` + `node:assert/strict`.

---

## Files Changed

| File | Thay đổi |
|------|----------|
| `lib/skills.js` | Registry v2, parseFrameworks, score matching, validation, fallback helpers |
| `bin/omni.js` | Phase 2 dùng API mới từ lib/skills.js, UX messages |
| `test/skills.test.js` | Update toàn bộ test suite cho API mới |
| `templates/workflows/skill-manager.md` | Không đổi thêm (đã update ở commit trước) |

---

## Out of Scope

- External JSON/YAML registry (Approach C)
- Remote fetch registry từ GitHub
- Plugin interface cho custom skill mappings
- Thêm curated skills cho Go, Ruby, Java (chờ tìm được source chất lượng)
