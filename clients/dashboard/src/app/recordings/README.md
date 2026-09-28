# `src/app/recordings/` — the recordings page

`/recordings` (DB-50's list, DB-52's Download/Delete): every recording the signed-in account owns,
newest first, read from `GET /api/vexa/recordings`. Each row links to its meeting — where DB-50's
audio player and DB-51's click-a-segment-to-seek live — plus a **Download** link (the recording's
audio media file, via the `.../download` alias route) and a **Delete** button (confirm dialog,
`DELETE /api/vexa/recordings/<id>`, toast on success/failure). The view itself lives in
`src/components/RecordingsView.tsx` — this file only resolves the signed-in user and composes it
inside `Shell`, the same split every other route in `src/app/` uses.

The retention note ("Your plan: kept for N days") reads `limits.recording_retention_days` off
`GET /api/vexa/user/entitlements` — informational only. `GET /user/entitlements` (DB-70) has no
boolean "recordings enabled" flag on any plan; every plan gets the same list, player, download and
delete, so this page gates nothing on plan.
