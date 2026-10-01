/** Tags and speaker labels: the two metadata keys the dashboard owns. Weighted towards what is
 *  refused, because `isAnnotateBody` is the allowlist's body check for the annotate route and a
 *  shape it admits is a write the browser can make. */
import { describe, expect, it } from "vitest";
import {
  MAX_SPEAKER_LABELS,
  MAX_TAGS,
  isAnnotateBody,
  isTagFilterValue,
  isTagList,
  labelFor,
  nextSpeakerLabels,
  normalizeTag,
  speakerLabelsOf,
  tagFilterValue,
  tagsOf,
} from "../annotations";
import { toMeeting } from "../meetings";

describe("normalizeTag", () => {
  it("trims, collapses whitespace and lower-cases", () => {
    expect(normalizeTag("  Acme   Renewal ")).toBe("acme renewal");
  });
  it("refuses blank, over-long and control-character tags", () => {
    expect(normalizeTag("   ")).toBeNull();
    expect(normalizeTag("x".repeat(33))).toBeNull();
    expect(normalizeTag("x".repeat(32))).toBe("x".repeat(32));
    expect(normalizeTag("a\u0000b")).toBeNull();
  });
});

describe("tagsOf", () => {
  it("reads stored tags and skips anything another writer left malformed", () => {
    expect(tagsOf({ tags: ["sales", "Sales", 3, "", "sales", "q3"] })).toEqual(["sales", "q3"]);
  });
  it("is empty for a missing, non-object or non-array value", () => {
    expect(tagsOf(undefined)).toEqual([]);
    expect(tagsOf(null)).toEqual([]);
    expect(tagsOf({ tags: "sales" })).toEqual([]);
    expect(tagsOf([])).toEqual([]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `t${i}`);
    expect(tagsOf({ tags: many })).toHaveLength(MAX_TAGS);
  });
});

describe("speakerLabelsOf / labelFor", () => {
  it("keeps well-formed entries and drops the rest", () => {
    expect(speakerLabelsOf({ speaker_labels: { "Speaker 1": "Ada", "Speaker 2": "", "Speaker 3": 7 } }))
      .toEqual({ "Speaker 1": "Ada" });
  });
  it("is empty for a missing or non-object map", () => {
    expect(speakerLabelsOf({})).toEqual({});
    expect(speakerLabelsOf({ speaker_labels: ["Ada"] })).toEqual({});
    expect(speakerLabelsOf("x")).toEqual({});
  });
  it("treats __proto__ as an ordinary speaker, never a prototype write", () => {
    const labels = speakerLabelsOf(JSON.parse('{"speaker_labels": {"__proto__": "Ada"}}'));
    expect(Object.getPrototypeOf(labels)).toBe(Object.prototype);
    expect(labelFor(labels, "__proto__")).toBe("Ada");
  });
  it("falls back to the producer's speaker, including for inherited names", () => {
    expect(labelFor({}, "Speaker 1")).toBe("Speaker 1");
    expect(labelFor({}, "toString")).toBe("toString");
  });
});

describe("nextSpeakerLabels", () => {
  it("adds, renames and removes labels; a blank or unchanged name removes", () => {
    expect(nextSpeakerLabels({ A: "Ada", B: "Bea" }, { A: "  Ada  Lovelace ", B: "", C: "C" }))
      .toEqual({ A: "Ada Lovelace" });
  });
  it("is null once nothing is left, so the key is deleted rather than stored empty", () => {
    expect(nextSpeakerLabels({ A: "Ada" }, { A: "" })).toBeNull();
    expect(nextSpeakerLabels({}, {})).toBeNull();
  });
});

describe("isAnnotateBody", () => {
  it("admits a rename", () => {
    expect(isAnnotateBody({ title: "Design review" })).toBe(true);
    expect(isAnnotateBody({ title: "" })).toBe(true);
  });
  it("admits the two owned metadata keys, set or cleared", () => {
    expect(isAnnotateBody({ metadata: { tags: ["sales", "q3"] } })).toBe(true);
    expect(isAnnotateBody({ metadata: { tags: null } })).toBe(true);
    expect(isAnnotateBody({ metadata: { speaker_labels: { "Speaker 1": "Ada" } } })).toBe(true);
    expect(isAnnotateBody({ metadata: { speaker_labels: null } })).toBe(true);
  });
  it("refuses any other metadata key, so no other writer's key can be touched", () => {
    expect(isAnnotateBody({ metadata: { crm_id: "acme-42" } })).toBe(false);
    expect(isAnnotateBody({ metadata: { notes: null } })).toBe(false);
    expect(isAnnotateBody({ metadata: { tags: ["a"], crm_id: "x" } })).toBe(false);
  });
  it("refuses two top-level keys, an unknown key, and non-object bodies", () => {
    expect(isAnnotateBody({ title: "x", metadata: { tags: ["a"] } })).toBe(false);
    expect(isAnnotateBody({ status: "completed" })).toBe(false);
    expect(isAnnotateBody(undefined)).toBe(false);
    expect(isAnnotateBody([])).toBe(false);
    expect(isAnnotateBody("title")).toBe(false);
  });
  it("refuses malformed values", () => {
    expect(isAnnotateBody({ title: 3 })).toBe(false);
    expect(isAnnotateBody({ title: "x".repeat(513) })).toBe(false);
    expect(isAnnotateBody({ metadata: { tags: [] } })).toBe(false);
    expect(isAnnotateBody({ metadata: { tags: ["Upper"] } })).toBe(false);
    expect(isAnnotateBody({ metadata: { tags: ["a", "a"] } })).toBe(false);
    expect(isAnnotateBody({ metadata: { tags: "a" } })).toBe(false);
    expect(isAnnotateBody({ metadata: { speaker_labels: {} } })).toBe(false);
    expect(isAnnotateBody({ metadata: { speaker_labels: { A: " Ada" } } })).toBe(false);
    expect(isAnnotateBody({ metadata: { speaker_labels: { A: "x".repeat(81) } } })).toBe(false);
    expect(isAnnotateBody({ metadata: { speaker_labels: { "": "Ada" } } })).toBe(false);
    expect(isAnnotateBody({ metadata: { speaker_labels: { A: 1 } } })).toBe(false);
    const tooMany = Object.fromEntries(Array.from({ length: MAX_SPEAKER_LABELS + 1 }, (_, i) => [`S${i}`, "x"]));
    expect(isAnnotateBody({ metadata: { speaker_labels: tooMany } })).toBe(false);
  });
});

describe("isTagList", () => {
  it("requires normalized, unique, bounded entries", () => {
    expect(isTagList(["a", "b c"])).toBe(true);
    expect(isTagList(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`))).toBe(false);
    expect(isTagList([" a"])).toBe(false);
  });
});

describe("tag filter value", () => {
  it("round-trips one tag", () => {
    expect(tagFilterValue("acme renewal")).toBe('{"tags":["acme renewal"]}');
    expect(isTagFilterValue(tagFilterValue("acme renewal"))).toBe(true);
  });
  it("refuses any other containment filter", () => {
    expect(isTagFilterValue('{"crm_id":"acme-42"}')).toBe(false);
    expect(isTagFilterValue('{"tags":["a","b"]}')).toBe(false);
    expect(isTagFilterValue('{"tags":[]}')).toBe(false);
    expect(isTagFilterValue('{"tags":["A"]}')).toBe(false);
    expect(isTagFilterValue('{"tags":["a"],"x":1}')).toBe(false);
    expect(isTagFilterValue('{"tags":"a"}')).toBe(false);
    expect(isTagFilterValue("not json")).toBe(false);
    expect(isTagFilterValue('["a"]')).toBe(false);
  });
});

describe("toMeeting — annotations", () => {
  it("reads tags and speaker labels off data.metadata", () => {
    const m = toMeeting({
      id: 1, platform: "zoom", native_meeting_id: "1", status: "completed",
      data: { metadata: { tags: ["sales"], speaker_labels: { "Speaker 1": "Ada" }, crm_id: "x" } },
    });
    expect(m.tags).toEqual(["sales"]);
    expect(m.speakerLabels).toEqual({ "Speaker 1": "Ada" });
  });
  it("is empty when the row carries no metadata", () => {
    const m = toMeeting({ id: 1, platform: "zoom", native_meeting_id: "1", status: "completed" });
    expect(m.tags).toEqual([]);
    expect(m.speakerLabels).toEqual({});
  });
});
