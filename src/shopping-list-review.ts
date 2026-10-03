import terminalKit from "terminal-kit";
import type { GroceryIngredient, ShoppingList } from "./types.js";

const { terminal: term, truncateString, stringWidth } = terminalKit;
const truncateWithEllipsis = (value: string, width: number): string => {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  if (width === 1) return "…";
  return `${truncateString(value, width - 1)}…`;
};
const safeText = (value: string): string => Array.from(value)
  .filter((character) => {
    const code = character.codePointAt(0)!;
    return code >= 32 && code !== 127 && (code < 128 || code > 159);
  }).join("");

export interface ShoppingListReviewOptions {
  signal?: AbortSignal;
  continueLabel?: string;
}

/**
 * Show a mouse- and keyboard-operable review of a compiled shopping list.
 * Returns the IDs the user kept, or null when they cancel the review.
 * This function never starts the cart flow.
 */
export function reviewShoppingList(
  list: ShoppingList,
  options: ShoppingListReviewOptions = {},
): Promise<Set<string> | null> {
  const ingredients = list.ingredients ?? list.recipes.flatMap((recipe) => recipe.ingredients);
  if (ingredients.length === 0) return Promise.resolve(new Set());
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("Shopping list review needs an interactive terminal."));
  }
  if (options.signal?.aborted) return Promise.resolve(null);

  return new Promise((resolve) => {
    const selected = new Set(ingredients.map((ingredient) => ingredient.id));
    let focusIndex = 0;
    let scrollOffset = 0;
    let finished = false;
    const output = process.stdout;

    const dimensions = () => ({
      width: Math.max(30, output.columns || term.width || 80),
      height: Math.max(10, output.rows || term.height || 24),
    });

    const itemText = (ingredient: GroceryIngredient, width: number): string => {
      const safeWidth = Math.max(1, width);
      const prefix = `[${selected.has(ingredient.id) ? "x" : " "}] `;
      const total = ingredient.purchaseRequirement?.total;
      let quantity = "";
      if (total) {
        const amount = Number.isInteger(total.quantity) ? String(total.quantity) : String(Number(total.quantity.toFixed(2)));
        const unit = total.unit && total.unit !== "count" ? ` ${safeText(total.unit)}` : "";
        quantity = `${total.approximate ? "~" : ""}${amount}${unit}`;
      }
      const optional = ingredient.purchaseRequirement?.optional ? " (opt)" : "";
      const tail = `${quantity}${optional}`;
      const tailLimit = Math.max(0, Math.min(16, Math.floor(safeWidth / 3), safeWidth - stringWidth(prefix) - 8));
  const clippedTail = tail ? truncateWithEllipsis(tail, tailLimit) : "";
      const separator = clippedTail ? "  " : "";
      const nameWidth = Math.max(1, safeWidth - stringWidth(prefix) - stringWidth(separator) - stringWidth(clippedTail));
  const name = truncateWithEllipsis(safeText(ingredient.request), nameWidth);
      const content = `${prefix}${name}${separator}${clippedTail}`;
      return content + " ".repeat(Math.max(0, safeWidth - stringWidth(content)));
    };

    const render = () => {
      if (finished) return;
      const { width, height } = dimensions();
      const listTop = 4;
      const footerTop = height - 3;
      const visibleRows = Math.max(1, footerTop - listTop);
      if (focusIndex < ingredients.length && focusIndex < scrollOffset) scrollOffset = focusIndex;
      if (focusIndex < ingredients.length && focusIndex >= scrollOffset + visibleRows) {
        scrollOffset = focusIndex - visibleRows + 1;
      }
      scrollOffset = Math.min(scrollOffset, Math.max(0, ingredients.length - visibleRows));

      let screen = "\x1b[H\x1b[2J";
      const line = (y: number, text: string, focused = false): string =>
        `\x1b[${y};1H${focused ? "\x1b[7m" : ""}${truncateWithEllipsis(text, width - 1)}\x1b[K${focused ? "\x1b[0m" : ""}`;
      screen += line(1, `Shopping list review  ${selected.size}/${ingredients.length} selected`);
      screen += line(2, "Click an item or use ↑/↓ and Space to toggle. Optional items start selected.");
      for (let row = 0; row < visibleRows; row += 1) {
        const ingredient = ingredients[scrollOffset + row];
        if (!ingredient) {
          continue;
        }
        const isFocused = focusIndex === scrollOffset + row;
        screen += line(listTop + row, itemText(ingredient, width - 1), isFocused);
      }
      const focusedSources = ingredients[focusIndex]?.purchaseRequirement?.sources;
      const focusedRequirement = ingredients[focusIndex]?.purchaseRequirement;
      const fullQuantity = focusedRequirement?.total
        ? `${focusedRequirement.total.approximate ? "~" : ""}${focusedRequirement.total.quantity}${focusedRequirement.total.unit && focusedRequirement.total.unit !== "count" ? ` ${focusedRequirement.total.unit}` : ""}`
        : "not specified";
      const status = ingredients.length > visibleRows
        ? `Items ${scrollOffset + 1}–${Math.min(ingredients.length, scrollOffset + visibleRows)} of ${ingredients.length}`
        : "";
      const detail = `Quantity: ${safeText(fullQuantity)}${focusedRequirement?.optional ? " (optional)" : ""}  ·  Sources: ${focusedSources?.length ? focusedSources.map(safeText).join(", ") : "none recorded"}`;
      screen += line(footerTop, `${status}${status && detail ? "  ·  " : ""}${detail}`);
      const continueLabel = safeText(options.continueLabel ?? "Start cart");
      screen += `\x1b[${height - 1};1H${focusIndex === ingredients.length ? "\x1b[7m" : ""}  ${continueLabel}  ${focusIndex === ingredients.length ? "\x1b[0m" : ""}   Esc: cancel`;
      output.write(screen);
    };

    const cleanup = () => {
      term.removeListener("key", onKey);
      term.removeListener("mouse", onMouse);
      output.removeListener("resize", render);
      options.signal?.removeEventListener("abort", onAbort);
      term.grabInput(false);
      output.write("\x1b[?1049l\x1b[?25h\x1b[0m");
    };

    const finish = (result: Set<string> | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => finish(null);
    const onKey = (name: string) => {
      if (name === "ESCAPE" || name === "CTRL_C" || name === "q") {
        finish(null);
        return;
      }
      if (name === "UP" || name === "k") focusIndex = Math.max(0, focusIndex - 1);
      else if (name === "DOWN" || name === "j") focusIndex = Math.min(ingredients.length, focusIndex + 1);
      else if (name === "PAGE_UP") focusIndex = Math.max(0, focusIndex - Math.max(1, dimensions().height - 7));
      else if (name === "PAGE_DOWN") focusIndex = Math.min(ingredients.length, focusIndex + Math.max(1, dimensions().height - 7));
      else if (name === "HOME") focusIndex = 0;
      else if (name === "END") focusIndex = ingredients.length;
      else if (name === "SPACE" || name === " ") {
        const ingredient = ingredients[focusIndex];
        if (ingredient) {
          if (selected.has(ingredient.id)) selected.delete(ingredient.id);
          else selected.add(ingredient.id);
        }
      } else if (name === "ENTER" || name === "KP_ENTER") {
        if (focusIndex === ingredients.length) {
          finish(new Set(selected));
          return;
        } else {
          const ingredient = ingredients[focusIndex];
          if (ingredient) {
            if (selected.has(ingredient.id)) selected.delete(ingredient.id);
            else selected.add(ingredient.id);
          }
        }
      }
      render();
    };
    const onMouse = (name: string, data: { x?: number; y?: number }) => {
      const { height } = dimensions();
      const listTop = 4;
      const footerTop = height - 3;
      const visibleRows = Math.max(1, footerTop - listTop);
      if (name === "MOUSE_WHEEL_UP") {
        scrollOffset = Math.max(0, scrollOffset - 3);
        focusIndex = scrollOffset;
      } else if (name === "MOUSE_WHEEL_DOWN") {
        scrollOffset = Math.min(Math.max(0, ingredients.length - visibleRows), scrollOffset + 3);
        focusIndex = Math.min(ingredients.length - 1, scrollOffset + visibleRows - 1);
      } else if (name === "MOUSE_LEFT_BUTTON_PRESSED" && data.y !== undefined) {
        const row = data.y - listTop;
        if (row >= 0 && row < visibleRows) {
          const index = scrollOffset + row;
          const ingredient = ingredients[index];
          if (ingredient) {
            focusIndex = index;
            if (selected.has(ingredient.id)) selected.delete(ingredient.id);
            else selected.add(ingredient.id);
          }
        } else if (
          data.y === height - 1 && data.x !== undefined && data.x >= 3 &&
          data.x <= 2 + stringWidth(safeText(options.continueLabel ?? "Start cart"))
        ) {
          focusIndex = ingredients.length;
          finish(new Set(selected));
          return;
        }
      }
      render();
    };

    output.write("\x1b[?1049h\x1b[?25l");
    term.grabInput({ mouse: "button" });
    term.on("key", onKey);
    term.on("mouse", onMouse);
    output.on("resize", render);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    render();
  });
}
