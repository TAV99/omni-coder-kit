# Bookshelf acceptance plan (suite v1)

Register all ten tasks together in one plan revision and one plan gate. All tasks use isolated execution, risk low and no dependency installation. Allowed-file overlap is intentional: the scheduler must serialize conflicts and may run disjoint scopes in parallel within runtime limits. There are no task dependencies.

T08 and T10 are conceptually high difficulty; registration complexity is medium so they remain eligible isolated slices. Do not fix another task while working on the assigned one.

Validate each task with `node --test` before hidden tests are introduced. The initial visible tests pass. At the end of the run, the controller evaluates separate hidden acceptance tests.

## T01 — Case-insensitive author lookup

Make Catalog.findByAuthor(author) compare complete author names case-insensitively, preserving book order and existing case-sensitive ID operations.

Allowed files: `lib/catalog.js`.

## T02 — Reject missing book titles

Make Catalog.addBook throw TypeError before mutation if title is missing, null, not a string, empty, or whitespace-only. Preserve valid title text and existing add/find/remove behaviour.

Allowed files: `lib/catalog.js`.

## T03 — Parse quoted CSV fields

Make csv.parse handle quoted fields containing commas and escaped double quotes (two quotes encode one). Preserve header rows, empty fields, trailing LF and CRLF behaviour. Add visible regression tests in test/csv.test.js; keep stringify compatible.

Allowed files: `lib/csv.js`, `test/csv.test.js`.

## T04 — Search catalog and CLI

Add Catalog.search(query): match a case-insensitive substring in title or author, in catalog order; empty query returns all books, no matches returns []. Implement CLI search <query> with list-style text output and --file support. Preserve list/add behaviour.

Allowed files: `lib/catalog.js`, `bin/cli.js`.

## T05 — Share date formatting

Move duplicated report/CLI date formatting into format.date(value) in lib/format.js. Report and CLI must call that shared function. Preserve output byte-for-byte: missing/invalid values become unknown; other values use new Date(value).toISOString().slice(0,10). Preserve report latest-date selection, price formatting and all unrelated behaviour.

Allowed files: `lib/format.js`, `lib/report.js`, `bin/cli.js`.

## T06 — Cover price formatting edge cases

Add tests only in test/format.test.js for format.price: zero, negative numbers, fractional rounding/two decimal digits, and TypeError for nonnumbers/NaN/Infinity. Existing price implementation is correct; preserve its finite-number contract. New tests must fail if zero loses its decimal places, negatives lose their sign, fractions become unrounded, or invalid inputs are accepted.

Allowed files: `test/format.test.js`.

## T07 — JSON list output and documentation

Add a boolean --json flag to CLI list: write a valid JSON array of all books, preserving every field/value and order, including [] for an empty catalog. Preserve ordinary text list and add. Document the list --json command and JSON output in README.md.

Allowed files: `bin/cli.js`, `README.md`.

## T08 — Finance CSV export

Implement csv.exportFinance(books) in the format the finance team needs. The required columns, their order and formatting have deliberately not been supplied. Ask for sourced business context with NEEDS_CONTEXT before implementing; do not infer a format. Keep general CSV parsing/stringifying behaviour unchanged.

Allowed files: `lib/csv.js`.

## T09 — Round catalog totals once

Fix report.total: add raw finite numeric book prices, then round the sum to two decimals once; return a number, and 0 for an empty catalog. For example two prices of 0.014 total 0.03, and 0.1 + 0.2 totals 0.3. Individual price formatting already works; only lib/report.js may change, even if changing lib/format.js appears convenient.

Allowed files: `lib/report.js`.

## T10 — Count valid years and unknown dates

Fix report.byYear to return an object counting books by UTC year without mutating input; [] returns {}. Count missing, null, empty, nonstring, year-only and malformed dates under unknown. Accept YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.fraction]] followed by Z or +/-HH:mm; fraction length is unbounded, hours 00-23 and minutes/seconds 00-59. Other forms are unknown. Validate real calendar dates (leap years/month lengths), not just Date.parse; timezone offsets may move a timestamp to another UTC year. Visible tests miss these edge cases; check them in review.

Allowed files: `lib/report.js`.

## Context discipline

The finance format is intentionally absent from the initial workspace. T08 must request it, and wait for a sourced reply before implementation. Neither this plan nor the README supplies the finance columns. The controller retains the source document and releases it only after the question.
