- **Calendar token encryption moves to AES-256-GCM (#1670).** `admin-api`'s stored Google
  Calendar refresh token now uses AES-256-GCM (`cryptography`) instead of the hand-built
  HMAC-CTR-plus-encrypt-then-MAC construction, with the associated data bound to the user id and
  calendar connection id so a ciphertext copied to another row fails to decrypt.
  `CALENDAR_TOKEN_ENCRYPTION_KEY` is now standard base64 of exactly 32 raw bytes (was a
  free-form string); see [Calendar sync](/how-to/calendar-sync). No stored connection existed in
  the old format (DB-31, the first caller that could persist one, had not shipped), so there is
  nothing to migrate.
