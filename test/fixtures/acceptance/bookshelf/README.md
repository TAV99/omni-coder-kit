# Bookshelf

Acceptance suite v1: a dependency-free CommonJS library and CLI for a small book catalog. Requires Node 20 or later. The starting project has deliberate gaps described in `plans/plan.md`; its visible tests pass.

```sh
npm test
node bin/cli.js add --file books.json --id dune --title Dune --author "Frank Herbert" --price 12 --published-at 1965-08-01
node bin/cli.js list --file books.json
```

## Data and library API

A book has `{ id, title, author, price, publishedAt }`. The catalog file is a JSON array. `publishedAt` may be missing. Inputs are trusted local fixture data, not a network service.

- `new Catalog(books = [])` copies the input array; `list()` returns a separate array.
- `addBook(book)` stores a shallow copy and returns the stored book. T02 adds title validation: a nonblank string is required, with `TypeError` before mutation otherwise. Valid title whitespace is preserved.
- `findById(id)` returns the first matching book or `undefined`; `removeBook(id)` returns a boolean.
- `findByAuthor(author)` matches the complete author; T01 makes that comparison case-insensitive.
- T04 adds `search(query)`: case-insensitive substring matching of title or author, preserving order. An empty query returns every book; no matches returns `[]`.
- `csv.parse(text)` returns arrays of string fields including the header; `csv.stringify(rows)` emits a trailing LF for nonempty rows and `''` for no rows. T03 adds quoted commas, escaped quotes (`""`), CRLF and empty fields.
- `format.price(value)` accepts only finite numbers, including zero, negatives and fractions; it returns `value.toFixed(2)`. Other inputs throw `TypeError`. T06 adds edge-case tests without changing this contract.
- Dates in report/CLI output use `new Date(value).toISOString().slice(0, 10)` or `unknown` for missing/invalid values. T05 moves that exact behaviour into `format.date` and makes both callers use it.
- `report.total(books)` should sum raw numeric prices and round once to two decimals. T09 fixes the existing per-item rounding without changing `format.price`.
- `report.summary(books)` returns `Books: <count>`, `Total: <price>`, `Latest: <UTC date>` on separate LF-terminated lines. Latest selection remains the last nonempty date string in lexical order.
- T10 fixes `report.byYear(books)`: count valid dates by UTC year, put missing/malformed dates in `unknown`, return `{}` for no books and never mutate the input. Accept `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm[:ss[.fraction]]` followed by `Z` or `±HH:mm` (arbitrary fractional precision; hours 00–23, minutes/seconds 00–59); reject year-only strings, nonstrings and impossible calendar dates (including invalid leap days).

## CLI

`list` renders `id | title | author | price | date` per book. `add` persists the array. `--file` selects the catalog file (default `books.json`); a missing file starts empty. T04 adds `search <query>`, with the same text output as list. Unknown commands exit nonzero with a message on stderr.

## Working on the suite

The ten tasks are independent changes against the starting project, with overlapping scopes intentionally retained for scheduler testing. See `plans/plan.md` for goals and file boundaries. Implement only the assigned task; do not repair adjacent gaps. The finance export task deliberately lacks its business format: request sourced context before implementing it.
