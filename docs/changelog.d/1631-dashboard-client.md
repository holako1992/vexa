- **New: a simple meetings + transcripts dashboard, alongside the Terminal.** `clients/dashboard` is a
  second web client on its own port (dev `3001`, compose `13002`) for people who want to read their
  meetings rather than work in a workbench: a searchable list with live/past/upcoming filters, and a
  meeting page with the transcript, per-speaker attribution, in-transcript search, copy and download.
  It shares the Terminal's session contract, so behind one domain the two are a single sign-in. Every
  page is gated behind sign-in (Google / Microsoft OAuth), the API key stays server-side, and its one
  backend door is a closed read allowlist. The Terminal is unchanged. See
  [`clients/dashboard/README.md`](https://github.com/Vexa-ai/vexa/blob/main/clients/dashboard/README.md).
