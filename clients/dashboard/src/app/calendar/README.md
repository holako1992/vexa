# `src/app/calendar/` — Google Calendar OAuth's landing page

Holds only `google/callback/` (DB-31). There is no `/calendar` page of its own — connecting and
managing calendars lives in the "Add Bot" dialog's Calendar tab (`src/components/SendBotDialog.tsx`),
not a nav-rail destination; this directory exists purely so `GOOGLE_CALENDAR_REDIRECT_URI` has a
route to point at.
