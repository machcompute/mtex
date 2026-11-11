import { describe, expect, it } from "vitest";
import { FakeBusyTex } from "../support/fake-busytex";
import { advance, fileRows, mountEditor, projectNameValue, settle, statusText } from "../support/page-utils";
import { listProjects } from "@/lib/opfs";

describe("smoke", () => {
  it("first run creates the default project and auto-compiles it", async () => {
    await mountEditor();
    await advance(10);
    expect(projectNameValue()).toBe("LaTeX project");
    expect(fileRows().sort()).toEqual(["main.tex", "refs.bib"]);
    expect(statusText()).toMatch(/Compiled in \d+ ms/);
    expect(FakeBusyTex.calls).toHaveLength(1);
    expect((await listProjects()).length).toBe(1);
    await settle();
  });
});
