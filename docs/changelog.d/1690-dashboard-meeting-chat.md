- **Ask the assistant about a meeting, or across all your meetings, from the dashboard (#1690).**
  A meeting's owner gets an "Ask about this meeting" side panel; `/search` gets "Ask across all my
  meetings". Both use `POST /agent/chat` through the dashboard's allowlist, which admits only
  those two body shapes. The answer appears as it streams, Stop closes the stream, and New
  conversation resets the thread. When no answer can come (no model credential, agent-api not
  running, no agent domain on the deployment), the panel says so in a sentence. Meetings shared
  with you have no chat. Verified against the dashboard's stub gateway only, with no live
  agent-api. See [Agent API](/api/agent).
