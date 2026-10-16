- **Agent turns work for accounts made outside the terminal, and flows can save a meeting's page.**
  agent-api now creates a subject's workspace tiers before every worker spawn (the runtime mounts
  them as volume subpaths, which must already exist — a dashboard Google sign-up failed every chat
  and summary with `cannot access path …/_data/<id>`), and gains `PUT /api/workspace/file`, which
  writes one file into the caller's own workspace and commits it — the door flows' post-meeting
  steps write the meeting page and `meetings/<id>/summary.md` through.
