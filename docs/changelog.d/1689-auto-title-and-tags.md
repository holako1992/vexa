- **Untitled meetings get a title and tags when their summary is written (#1689).** When
  `commit_meeting_summary` writes a `status: complete` note for a meeting that has no title, it
  writes one onto the meeting through `POST /meetings/{id}/annotate`: the invite's own subject when
  there is one, otherwise a short title from the same post-meeting turn that wrote the report (no
  second model call). Up to three tags, in the dashboard's stored form, go to `metadata.tags` when
  the meeting has none. The row is re-read right before the write, and a title or tags a person
  already set are never replaced; a skipped summary names nothing, and a labelling failure never
  affects the summary. See
  [Report after every meeting](/how-to/post-meeting-report#untitled-meetings-get-a-title-and-tags-db-62).
