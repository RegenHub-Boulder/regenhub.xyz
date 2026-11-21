import { expect, it } from "vitest";
import { plainWords } from "./badge";

it("turns enum values and lowercase labels into plain sentence-case words", () => {
  expect(plainWords("past_due")).toBe("Past due");
  expect(plainWords("trialing")).toBe("Trial");
  expect(plainWords("canceled")).toBe("Canceled");
  expect(plainWords("no code")).toBe("No code");
  expect(plainWords("thumb-turn")).toBe("Thumb-turn");
  // what a caller capitalised stays as written: proper nouns, acronyms, figures
  expect(plainWords("Card · Stripe")).toBe("Card · Stripe");
  expect(plainWords("Admin")).toBe("Admin");
  expect(plainWords("PDS error")).toBe("PDS error");
  expect(plainWords("$250/mo")).toBe("$250/mo");
});
