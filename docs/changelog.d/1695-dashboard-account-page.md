- **Account page with "Sign out everywhere" in the dashboard.** `/settings/account` shows your name,
  email, the sign-in method the account was created through and the browsers signed in to the
  dashboard (when each signed in and was last used). "Sign out everywhere" revokes every dashboard
  login token for your account, so any other browser is refused on its next request and lands on
  the sign-in page; API keys you made yourself are untouched. Deleting an account is not offered
  yet. A browser holding a revoked session now reaches the sign-in page instead of looping
  between it and the page it came from.
