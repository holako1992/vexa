/** `summary.v1` parsing (DB-60) — weighted toward malformed input, since a summary the dashboard
 *  cannot parse must render as its own distinct state (`SummaryPanel`'s `malformed` branch),
 *  never silently as "skipped" or an empty complete note. */
import { describe, expect, it } from "vitest";
import { parseInlineEmphasis, parseSummaryDoc } from "../summary";

const COMPLETE = `---
type: meeting-summary
version: v1
meeting_id: 104
status: complete
generated_at: 2026-06-24T14:05:00Z
---

## Overview
The team reviewed the Q3 roadmap.

## Decisions
Ship the export feature before the calendar sync work.

## Action items
- Dev to finish the DOCX exporter by Friday.
- Carla to schedule the design review.

## Open questions
_none recorded in this meeting._
`;

const SKIPPED = `---
type: meeting-summary
version: v1
meeting_id: 105
status: skipped
generated_at: 2026-06-24T14:05:00Z
reason: "fewer than 3 transcript segments"
---
`;

describe("parseSummaryDoc — complete", () => {
  it("parses front matter and all four sections", () => {
    const doc = parseSummaryDoc(COMPLETE);
    expect(doc.kind).toBe("complete");
    if (doc.kind !== "complete") throw new Error("unreachable");
    expect(doc.meetingId).toBe("104");
    expect(doc.status).toBe("complete");
    expect(doc.generatedAt).toBe("2026-06-24T14:05:00Z");
    expect(doc.overview).toContain("Q3 roadmap");
    expect(doc.decisions).toContain("export feature");
    expect(doc.actionItems).toEqual([
      "Dev to finish the DOCX exporter by Friday.",
      "Carla to schedule the design review.",
    ]);
    expect(doc.openQuestions).toContain("none recorded");
  });

  it("falls back to the section's own text when Action items has no bullets", () => {
    const doc = parseSummaryDoc(COMPLETE.replace(/- Dev.*\n- Carla.*\n/, "_none recorded in this meeting._\n"));
    if (doc.kind !== "complete") throw new Error("unreachable");
    expect(doc.actionItems).toEqual([]);
    expect(doc.actionItemsNote).toContain("none recorded");
  });
});

describe("parseSummaryDoc — skipped", () => {
  it("carries the producer's reason verbatim", () => {
    const doc = parseSummaryDoc(SKIPPED);
    expect(doc.kind).toBe("skipped");
    if (doc.kind !== "skipped") throw new Error("unreachable");
    expect(doc.meetingId).toBe("105");
    expect(doc.reason).toBe("fewer than 3 transcript segments");
  });
});

describe("parseSummaryDoc — malformed input", () => {
  it("empty document", () => {
    expect(parseSummaryDoc("")).toEqual({ kind: "malformed", detail: "empty document" });
  });

  it("missing front matter entirely", () => {
    const doc = parseSummaryDoc("## Overview\nJust a body, no front matter.\n");
    expect(doc).toEqual({ kind: "malformed", detail: "missing front matter" });
  });

  it("front matter with no closing fence", () => {
    const doc = parseSummaryDoc("---\ntype: meeting-summary\nversion: v1\nstatus: complete\n\n## Overview\nx\n");
    expect(doc.kind).toBe("malformed");
  });

  it("unknown version", () => {
    const bad = COMPLETE.replace("version: v1", "version: v2");
    expect(parseSummaryDoc(bad)).toEqual({ kind: "malformed", detail: "unsupported summary version 'v2'" });
  });

  it("missing version entirely", () => {
    const bad = COMPLETE.replace("version: v1\n", "");
    const doc = parseSummaryDoc(bad);
    expect(doc.kind).toBe("malformed");
  });

  it("wrong front-matter type", () => {
    const bad = COMPLETE.replace("type: meeting-summary", "type: something-else");
    expect(parseSummaryDoc(bad)).toEqual({
      kind: "malformed",
      detail: "unrecognized front-matter type 'something-else'",
    });
  });

  it("missing status", () => {
    const bad = COMPLETE.replace("status: complete\n", "");
    const doc = parseSummaryDoc(bad);
    expect(doc.kind).toBe("malformed");
  });

  it("missing a required section (Decisions)", () => {
    const bad = COMPLETE.replace(/## Decisions\n[\s\S]*?(?=## Action items)/, "");
    expect(parseSummaryDoc(bad)).toEqual({ kind: "malformed", detail: "missing section 'Decisions'" });
  });

  it("missing every section", () => {
    const bad = `---
type: meeting-summary
version: v1
meeting_id: 104
status: complete
generated_at: 2026-06-24T14:05:00Z
---

No sections at all, just prose.
`;
    expect(parseSummaryDoc(bad)).toEqual({ kind: "malformed", detail: "missing section 'Overview'" });
  });

  it("skipped with no reason", () => {
    const bad = SKIPPED.replace(/reason: .*\n/, "");
    expect(parseSummaryDoc(bad)).toEqual({ kind: "malformed", detail: "skipped summary carries no reason" });
  });

  it("status neither complete nor skipped", () => {
    const bad = COMPLETE.replace("status: complete", "status: pending");
    expect(parseSummaryDoc(bad)).toEqual({
      kind: "malformed",
      detail: "missing or invalid status 'pending'",
    });
  });
});

describe("parseInlineEmphasis", () => {
  it("renders the producer's own placeholder as emphasis, not literal underscores", () => {
    expect(parseInlineEmphasis("_none recorded in this meeting._")).toEqual([
      { text: "none recorded in this meeting.", emphasis: "em" },
    ]);
  });

  it("renders **strong** as a strong segment", () => {
    expect(parseInlineEmphasis("Ship the **export feature** first.")).toEqual([
      { text: "Ship the ", emphasis: "none" },
      { text: "export feature", emphasis: "strong" },
      { text: " first.", emphasis: "none" },
    ]);
  });

  it("leaves word-internal underscores alone — snake_case_name is not emphasis", () => {
    expect(parseInlineEmphasis("Rename snake_case_name to camelCase.")).toEqual([
      { text: "Rename snake_case_name to camelCase.", emphasis: "none" },
    ]);
  });

  it("plain text with no markdown round-trips as one segment", () => {
    expect(parseInlineEmphasis("No markdown here.")).toEqual([{ text: "No markdown here.", emphasis: "none" }]);
  });

  it("handles multiple emphasis runs and mixed strong/em in one string", () => {
    expect(parseInlineEmphasis("_first_ and **second** and _third_")).toEqual([
      { text: "first", emphasis: "em" },
      { text: " and ", emphasis: "none" },
      { text: "second", emphasis: "strong" },
      { text: " and ", emphasis: "none" },
      { text: "third", emphasis: "em" },
    ]);
  });

  it("does not treat an underscore glued to a word on one side as a delimiter", () => {
    // "file_name.txt" has no emphasis-worthy pair (both underscore neighbours are word chars),
    // and a trailing "_ok" has a word char right after its underscore, so it stays literal too.
    expect(parseInlineEmphasis("see file_name.txt or a_ok")).toEqual([
      { text: "see file_name.txt or a_ok", emphasis: "none" },
    ]);
  });
});
