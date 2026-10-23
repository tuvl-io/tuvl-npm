import { describe, expect, it } from "vitest";
import { toFormData } from "./form";

describe("toFormData", () => {
  it("returns undefined when no value is a file", () => {
    expect(toFormData({ name: "ada", tags: ["a"] })).toBeUndefined();
    expect(toFormData(undefined)).toBeUndefined();
  });

  it("puts files in file parts and everything else in text parts", () => {
    const form = toFormData({
      doc: new File(["hello"], "a.txt", { type: "text/plain" }),
      more: [new File(["1"], "b.txt"), new File(["2"], "c.txt")],
      note: "hi",
      qty: 3,
      tags: ["a", "b"],
      skipped: undefined,
      none: null,
    }) as FormData;
    expect((form.get("doc") as File).name).toBe("a.txt");
    expect(form.getAll("more").map((f) => (f as File).name)).toEqual(["b.txt", "c.txt"]);
    expect(form.get("note")).toBe("hi");
    expect(form.get("qty")).toBe("3");
    expect(form.get("tags")).toBe('["a","b"]');
    expect(form.has("skipped")).toBe(false);
    expect(form.has("none")).toBe(false);
  });
});
