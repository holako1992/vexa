- **Dashboard e2e suite: 14/14 clean, order no longer matters (#1640).** The full
  `npm run test:e2e` run used to fail 4 of 14 checks — always the same four — while every one of
  them was green alone. The remaining failure once the sign-in load was ruled out
  (`e2e/specs/helpers.ts`'s `signIn()` already gives each spec its own `X-Forwarded-For` bucket
  against `lib/rateLimit.ts`, confirmed by re-running the full suite clean) was a genuine
  `SendBotDialog` defect: the meeting-link tab's own parse effect cleared the "Bot is joining the
  meeting." confirmation the instant `send()` cleared the URL field for the next paste, so the
  confirmation could never be seen — in a real browser, not just under load. Fixed at the point of
  introduction in `src/components/SendBotDialog.tsx` (the confirmation now clears only when the
  visitor edits the field themselves) and `src/components/MeetingsView.tsx` (sending a bot no
  longer closes the dialog out from under its own confirmation).
