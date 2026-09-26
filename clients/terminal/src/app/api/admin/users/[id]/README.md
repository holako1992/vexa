# [id]

The dynamic segment — a user id. `PATCH` forwards the admin overrides form's body
(`max_concurrent_bots`, `plan_override`, `quota_bonus`) to admin-api's `PATCH /admin/users/{id}`
and passes its response (200 or its validation error) straight through.
