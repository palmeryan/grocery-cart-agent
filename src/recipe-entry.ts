import { StringDecoder } from "node:string_decoder";
import terminalKit from "terminal-kit";
import type { RecipeDocument } from "./ingredients-agent.js";

const { terminal: term, stringWidth, truncateString } = terminalKit;
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** Parse terminal input without interpreting any bytes inside a bracketed paste as controls. */
export interface BracketedPasteConsumer {
  (chunk: string): void;
  dispose(): void;
}

export function createBracketedPasteConsumer(
  onKey: (sequence: string) => void,
  onPaste: (text: string) => void,
  onMouse?: (button: number, x: number, y: number) => void,
): BracketedPasteConsumer {
  let pending = "";
  let paste = false;
  let pasted = "";
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const consume: BracketedPasteConsumer = (chunk: string) => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = undefined;
    pending += chunk;
    while (pending) {
      if (paste) {
        const end = pending.indexOf(PASTE_END);
        if (end < 0) {
          const keep = Math.min(PASTE_END.length - 1, pending.length);
          pasted += pending.slice(0, pending.length - keep);
          pending = pending.slice(pending.length - keep);
          return;
        }
        pasted += pending.slice(0, end);
        pending = pending.slice(end + PASTE_END.length);
        paste = false;
        onPaste(pasted);
        pasted = "";
        continue;
      }
      if (pending.startsWith(PASTE_START)) {
        pending = pending.slice(PASTE_START.length);
        paste = true;
        pasted = "";
        continue;
      }
      if (pending[0] === "\u001b") {
        // eslint-disable-next-line no-control-regex
        const match = pending.match(/^\u001b(?:\[[0-?]*[ -/]*[@-~]|O.)/);
        if (!match) {
          escapeTimer = setTimeout(() => {
            escapeTimer = undefined;
            if (pending.startsWith("\u001b")) {
              onKey("\u001b");
              pending = pending.slice(1);
              consume("");
            }
          }, 40);
          return;
        } else {
          // eslint-disable-next-line no-control-regex
          const mouse = match[0].match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/);
          if (mouse) {
            if (mouse[4] === "M") onMouse?.(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]));
          }
          else onKey(match[0]);
          pending = pending.slice(match[0].length);
        }
      } else {
        const char = Array.from(pending)[0]!;
        pending = pending.slice(char.length);
        onKey(char);
      }
    }
  };
  consume.dispose = () => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = undefined;
  };
  return consume;
}

export interface RecipeEntryOptions {
  signal?: AbortSignal;
}

/** Derive a display/source name without changing the supplied recipe text. */
export function nameRecipe(text: string, index: number, existing: readonly string[] = []): string {
  const heading = text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  const base = heading || `Recipe ${index + 1}`;
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}

/**
 * Collect recipes in an interactive terminal. Bracketed paste is consumed from
 * stdin as one payload, so newlines and words inside a paste cannot activate
 * controls. Added documents are returned in memory and are never written out.
 */
export function enterRecipes(options: RecipeEntryOptions = {}): Promise<RecipeDocument[] | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("Recipe entry needs an interactive terminal."));
  }
  if (options.signal?.aborted) return Promise.resolve(null);

  return new Promise((resolve) => {
    const output = process.stdout;
    const recipes: RecipeDocument[] = [];
    let value = "";
    let cursor = 0;
    let selected = 0;
    let editing: number | null = null;
    let finished = false;
    let focus = 0; // 0 editor, 1 add/save, 2 make, 3 cancel, 4 edit, 5 remove
    const decoder = new StringDecoder("utf8");

    const size = () => ({
      width: Math.max(40, output.columns || term.width || 80),
      height: Math.max(18, output.rows || term.height || 24),
    });
    const safeLine = (text: string, width: number): string => {
      const safe = Array.from(text).filter((character) => {
        const code = character.codePointAt(0)!;
        return (code >= 32 && !(code >= 127 && code <= 159)) || character === "\t";
      }).join("");
      return stringWidth(safe) <= width ? safe : truncateString(safe, Math.max(0, width - 1)) + "…";
    };
    const render = () => {
      if (finished) return;
      const { width, height } = size();
      const line = (row: number, text: string, active = false) => {
        const content = safeLine(text, width - 2);
        return `\u001b[${row};2H${active ? "\u001b[7m" : ""}${content}\u001b[K${active ? "\u001b[0m" : ""}`;
      };
      let screen = "\u001b[H\u001b[2J";
      screen += line(1, "Recipe input");
      screen += line(2, "Paste or type a recipe below. Enter adds a line; Tab moves to the buttons.");
      screen += line(3, "Bracketed paste is kept as recipe text, including all newlines.");
      screen += line(4, `Recipe text${editing === null ? "" : ` — editing ${recipes[editing]?.sourceName ?? "recipe"}`}`, focus === 0);
      const boxTop = 5;
      const boxHeight = 6;
      const textLines = value.split("\n");
      const cursorLine = value.slice(0, cursor).split("\n").length - 1;
      const start = Math.max(0, Math.min(cursorLine - boxHeight + 1, textLines.length - boxHeight));
      for (let row = 0; row < boxHeight; row += 1) {
        screen += line(boxTop + row, textLines[start + row] ?? "", focus === 0 && start + row === cursorLine);
      }
      screen += line(12, `Added recipes (${recipes.length})`);
      const listRows = Math.max(1, Math.min(5, height - 18));
      const listStart = Math.max(0, Math.min(selected - listRows + 1, recipes.length - listRows));
      for (let row = 0; row < listRows; row += 1) {
        const index = listStart + row;
        const recipe = recipes[index];
        screen += line(13 + row, recipe ? `${index === selected ? "›" : " "} ${recipe.sourceName}` : "", focus === 4 && index === selected);
      }
      const buttonY = height - 4;
      const buttonRow = (row: number, buttons: Array<[string, number]>) => {
        const segment = Math.floor((width - 2) / buttons.length);
        buttons.forEach(([label, id], index) => {
          const text = `${id === focus ? "› " : "  "}[${label}]`;
          screen += `\u001b[${row};${2 + index * segment}H${id === focus ? "\u001b[7m" : ""}${safeLine(text, segment - 1)}\u001b[K${id === focus ? "\u001b[0m" : ""}`;
        });
      };
      buttonRow(buttonY, [[editing === null ? "Add recipe" : "Save edit", 1], ["Make shopping list", 2], ["Cancel", 3]]);
      buttonRow(buttonY + 1, [["Edit selected", 4], ["Remove selected", 5]]);
      screen += line(height, "↑/↓ select recipe   Tab/Shift+Tab move   Enter activate   Esc cancel");
      if (focus === 0) {
        const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
        const column = stringWidth(textLines[cursorLine]?.slice(0, cursor - lineStart) ?? "");
        screen += `\u001b[${boxTop + cursorLine - start};${2 + Math.min(column, width - 4)}H\u001b[?25h`;
      } else screen += "\u001b[?25l";
      output.write(screen);
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      output.removeListener("resize", render);
      options.signal?.removeEventListener("abort", onAbort);
      consume.dispose();
      output.write("\u001b[?2004l\u001b[?1006l\u001b[?1000l\u001b[?1049l\u001b[?25h\u001b[0m");
      term.grabInput(false);
    };
    const finish = (result: RecipeDocument[] | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => finish(null);
    const addOrSave = () => {
      const text = value.trim();
      if (!text) return;
      if (editing !== null) {
        const current = recipes[editing];
        if (current) {
          current.text = value;
          current.sourceName = nameRecipe(value, editing, recipes.filter((_, index) => index !== editing).map((recipe) => recipe.sourceName));
        }
        editing = null;
      } else {
        const name = nameRecipe(value, recipes.length, recipes.map((recipe) => recipe.sourceName));
        recipes.push({ sourceName: name, text: value });
        selected = recipes.length - 1;
      }
      value = "";
      cursor = 0;
      focus = 0;
      render();
    };
    const activate = (id: number) => {
      if (id === 1) addOrSave();
      else if (id === 2) {
        if (value.trim()) addOrSave();
        if (recipes.length) finish(recipes.map((recipe) => ({ ...recipe })));
      } else if (id === 3) finish(null);
      else if (id === 4 && recipes[selected]) {
        editing = selected;
        value = recipes[selected]!.text;
        cursor = value.length;
        focus = 0;
        render();
      } else if (id === 5 && recipes[selected]) {
        recipes.splice(selected, 1);
        selected = Math.min(selected, recipes.length - 1);
        if (selected < 0) selected = 0;
        render();
      }
    };
    const insertText = (text: string) => {
      value = value.slice(0, cursor) + text + value.slice(cursor);
      cursor += text.length;
      render();
    };
    const handleKey = (sequence: string) => {
      if (sequence === "\u0003" || sequence === "\u001b") { finish(null); return; }
      if (sequence === "\t" || sequence === "\u001b[Z") {
        focus = (focus + (sequence === "\u001b[Z" ? 5 : 1)) % 6;
        render();
        return;
      }
      if (sequence === "\r" || sequence === "\n") {
        if (focus === 0) insertText("\n");
        else activate(focus);
        return;
      }
      if (sequence === "\u001b[A" || sequence === "\u001b[B") {
        if (focus === 0) {
          const before = value.slice(0, cursor);
          const lineStart = before.lastIndexOf("\n") + 1;
          const column = cursor - lineStart;
          if (sequence === "\u001b[A") {
            if (lineStart > 0) {
              const prevEnd = lineStart - 1;
              const prevStart = value.lastIndexOf("\n", prevEnd - 1) + 1;
              cursor = prevStart + Math.min(column, prevEnd - prevStart);
            }
          } else {
            const nextStart = value.indexOf("\n", cursor);
            if (nextStart >= 0) {
              const nextEnd = value.indexOf("\n", nextStart + 1);
              cursor = nextStart + 1 + Math.min(column, (nextEnd < 0 ? value.length : nextEnd) - nextStart - 1);
            }
          }
        } else if (recipes.length) {
          selected = sequence === "\u001b[A" ? Math.max(0, selected - 1) : Math.min(recipes.length - 1, selected + 1);
        }
        render();
        return;
      }
      if (sequence === "\u001b[C") cursor = Math.min(value.length, cursor + 1);
      else if (sequence === "\u001b[D") cursor = Math.max(0, cursor - 1);
      else if (sequence === "\u007f" || sequence === "\b") {
        if (cursor > 0) { value = value.slice(0, cursor - 1) + value.slice(cursor); cursor -= 1; }
      } else if (sequence === "\u001b[3~") {
        value = value.slice(0, cursor) + value.slice(cursor + 1);
      } else if (sequence === "\u001b[H" || sequence === "\u001b[1~") cursor = value.lastIndexOf("\n", cursor - 1) + 1;
      else if (sequence === "\u001b[F" || sequence === "\u001b[4~") {
        const end = value.indexOf("\n", cursor);
        cursor = end < 0 ? value.length : end;
      } else if (Array.from(sequence).length === 1 && sequence >= " " && sequence !== "\u007f") insertText(sequence);
      render();
    };
    const onMouse = (button: number, x: number, y: number) => {
      if (button !== 0) return;
      if (y >= 5 && y <= 10) focus = 0;
      else if (y >= 13 && y < 13 + Math.max(1, Math.min(5, size().height - 18))) {
        const listRows = Math.max(1, Math.min(5, size().height - 18));
        const listStart = Math.max(0, Math.min(selected - listRows + 1, recipes.length - listRows));
        const index = listStart + y - 13;
        if (!recipes[index]) return;
        selected = index;
        focus = 4;
      } else if (y === size().height - 4) {
        const segment = Math.floor((size().width - 2) / 3);
        activate(Math.min(3, Math.floor(Math.max(0, x - 2) / segment) + 1));
      } else if (y === size().height - 3) {
        const segment = Math.floor((size().width - 2) / 2);
        activate(Math.min(5, Math.floor(Math.max(0, x - 2) / segment) + 4));
      }
      render();
    };
    const consume = createBracketedPasteConsumer(handleKey, insertText, onMouse);
    const onData = (chunk: Buffer | string) => consume(typeof chunk === "string" ? chunk : decoder.write(chunk));

    term.grabInput({ mouse: "button" });
    output.write("\u001b[?1049h\u001b[?25l\u001b[?2004h\u001b[?1006h\u001b[?1000h");
    process.stdin.on("data", onData);
    output.on("resize", render);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    render();
  });
}
