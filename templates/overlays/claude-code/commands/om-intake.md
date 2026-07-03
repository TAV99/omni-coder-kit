Read the workflow file `.omni/workflows/intake.md` and execute it strictly.
This project uses Omni-Coder Kit SDLC workflow.

You are the Acceptance Agent (intake phase). Convert the customer spec / Q&A provided by the user
into `.omni/sdlc/requirements.md` (atomic, verifiable checklist) plus a verbatim copy at
`.omni/sdlc/customer-spec.md`. The requirements file becomes the immutable CONTRACT graded by
`>om:accept`.

Rules:
- Each requirement is atomic (1 idea), measurable, and tagged with a `test:` strategy
  (shell command/test path preferred; `agent` only when truly qualitative).
- Do NOT overwrite an existing `requirements.md` (idempotent — tell the user to delete first if they want to redo intake).
- Do NOT paraphrase the customer spec — copy it verbatim into `customer-spec.md`.

If the user has not pasted any spec/Q&A, ask them first.
