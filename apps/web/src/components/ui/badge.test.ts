import { expect, it } from "vitest";
import { plainWords } from "./badge";

it("turns enum values and Title Case labels into plain sentence-case words", () => {
  expect(plainWords("past_due")).toBe("Past due");
  expect(plainWords("trialing")).toBe("Trial");
  expect(plainWords("canceled")).toBe("Canceled");
  expect(plainWords("no code")).toBe("No code");
  expect(plainWords("thumb-turn")).toBe("Thumb-turn");
  expect(plainWords("Cold Desk")).toBe("Cold desk");
  expect(plainWords("No Profile")).toBe("No profile");
  // single words, acronyms and figures stay as written
  expect(plainWords("Admin")).toBe("Admin");
  expect(plainWords("PDS error")).toBe("PDS error");
  expect(plainWords("$250/mo")).toBe("$250/mo");
});
