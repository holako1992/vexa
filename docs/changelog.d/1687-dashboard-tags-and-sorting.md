- **Tag meetings and filter the dashboard list by tag (#1687).** Add or remove tags on a meeting
  page; the list shows each meeting's tags, and choosing one narrows the list on the server
  (`GET /meetings?metadata={"tags":["<tag>"]}`), so paging walks only tagged meetings. The list can
  also be sorted newest, oldest, longest or by title, with live meetings kept on top. The
  dashboard's annotate route now admits only a rename or one of its own two metadata keys.
