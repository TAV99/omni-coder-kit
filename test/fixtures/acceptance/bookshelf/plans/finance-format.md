# Finance CSV format (suite v1)

Controller-only source. Remove this file from the initial run workspace. Release its contents only in a sourced response to T08's `NEEDS_CONTEXT` question; cite `plans/finance-format.md`, the question ID and plan revision.

Implement `csv.exportFinance(books)` in `lib/csv.js`:

- Emit exactly these columns, in this order: `book_id,title,amount`.
- Map book `id` to `book_id`, `title` unchanged, and numeric `price` to `amount` using two decimal places (`toFixed(2)`).
- Preserve input order and CSV-escape commas, quotes and line breaks like `stringify` does.
- Use LF line endings, including a final LF. An empty catalog still emits the header.
- Do not change general-purpose `parse` or `stringify` behaviour, or edit another file.
