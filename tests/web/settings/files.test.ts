// @vitest-environment jsdom
import type { ChangeEvent } from "react";

import { afterEach, describe, expect, it, vi } from "vitest";

import { read_picked, save_text } from "../../../src/web/settings/files.ts";

function picked(files: File[]): ChangeEvent<HTMLInputElement> {
  const input = document.createElement("input");
  input.type = "file";
  Object.defineProperty(input, "files", { value: files });
  return { currentTarget: input } as unknown as ChangeEvent<HTMLInputElement>;
}

afterEach(() => vi.restoreAllMocks());

describe("files the page reads and saves", () => {
  it("hands on the picked file's text, and nothing when none was picked", async () => {
    expect(await read_picked(picked([new File(['{"app":"codex"}'], "contexts.json")]))).toBe('{"app":"codex"}');
    expect(await read_picked(picked([]))).toBeNull();
  });

  it("offers text to save under the name given", () => {
    const create = vi.fn(() => "blob:saved");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });

    save_text("codex-contexts.json", "{}");
    expect(clicked).toEqual(["codex-contexts.json"]);
    expect(revoke).toHaveBeenCalledWith("blob:saved");
  });
});
