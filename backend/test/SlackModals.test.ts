/**
 * richTextToMarkdown tests: channel-style composer values become mrkdwn.
 */

import { describe, it, expect } from "vitest";

import { richTextToMarkdown, richTextInput } from "../slack/SlackModals.js";

function section(elements: unknown[]): unknown {
  return { elements: [{ type: "rich_text_section", elements }] };
}

describe("richTextToMarkdown", () => {
  it("passes plain strings through", () => {
    expect(richTextToMarkdown("hello")).toBe("hello");
    expect(richTextToMarkdown(undefined)).toBe("");
  });

  it("converts styles, users, and links", () => {
    const value = section([
      { type: "text", text: "db is " },
      { type: "text", text: "down", style: { bold: true } },
      { type: "text", text: " see " },
      { type: "user", user_id: "U1" },
      { type: "text", text: " " },
      { type: "link", url: "https://x.test", text: "dash" },
    ]);
    expect(richTextToMarkdown(value)).toBe("db is *down* see <@U1> <https://x.test|dash>");
  });

  it("converts bullet lists", () => {
    const value = {
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "one" }] },
            { type: "rich_text_section", elements: [{ type: "text", text: "two" }] },
          ],
        },
      ],
    };
    expect(richTextToMarkdown(value)).toBe("• one\n• two");
  });

  it("builds a rich composer with optional initial text", () => {
    const view = richTextInput("desc", "Details", "seed") as Record<string, unknown>;
    expect(view.type).toBe("rich_text_input");
    expect(view.initial_value).toBeTruthy();
    const plain = richTextInput("desc", "Details") as Record<string, unknown>;
    expect(plain.initial_value).toBeUndefined();
  });
});
