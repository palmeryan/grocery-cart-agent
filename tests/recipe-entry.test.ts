import { describe, expect, it, vi } from "vitest";
import { createBracketedPasteConsumer, nameRecipe } from "../src/recipe-entry.js";

describe("recipe entry", () => {
  it("keeps bracketed multiline pastes atomic even when input chunks split the markers", () => {
    const keys: string[] = [];
    const pastes: string[] = [];
    const clicks: Array<[number, number, number]> = [];
    const consume = createBracketedPasteConsumer(
      (key) => keys.push(key),
      (text) => pastes.push(text),
      (button, x, y) => clicks.push([button, x, y]),
    );
    consume("\u001b[200~# First\nline\nNext recipe\n\u001b[201~\u001b[<0;10;");
    consume("20M\u001b[<0;10;20m");
    expect(pastes).toEqual(["# First\nline\nNext recipe\n"]);
    expect(keys).toEqual([]);
    expect(clicks).toEqual([[0, 10, 20]]);
    consume.dispose();
  });

  it("uses the first Markdown heading and gives duplicate names unique suffixes", () => {
    expect(nameRecipe("Intro\n## Pasta bake\nbody", 0)).toBe("Pasta bake");
    expect(nameRecipe("# Pasta bake\n", 1, ["Pasta bake"])).toBe("Pasta bake (2)");
    expect(nameRecipe("plain recipe", 2)).toBe("Recipe 3");
  });

  it("cancels on a standalone Escape after a short terminal sequence window", async () => {
    vi.useFakeTimers();
    const keys: string[] = [];
    const consume = createBracketedPasteConsumer((key) => keys.push(key), () => undefined);
    consume("\u001b");
    vi.advanceTimersByTime(41);
    expect(keys).toEqual(["\u001b"]);
    consume.dispose();
    vi.useRealTimers();
  });
});
