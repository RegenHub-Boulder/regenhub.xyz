import { describe, expect, it } from "vitest";
import { parseCsv, planLumaImport, readLumaCsv } from "./lumaCsv";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas and line breaks in fields, CRLF, a BOM and blank lines", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n"two\nlines",z')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["two\nlines", "z"],
    ]);
  });
});

describe("readLumaCsv", () => {
  it("finds the email column whatever its case or position, with a BOM before the header", () => {
    const r = readLumaCsv("﻿Name,EMAIL\nSam,SAM@Example.test\n");
    expect(r).toMatchObject({ contacts: [{ email: "sam@example.test", name: "Sam" }], rows: 1 });
  });
  it("skips Luma-unsubscribed, invalid and repeated (any case) rows, and counts each", () => {
    const r = readLumaCsv(
      "email,subscription_status,first_name,last_name\n" +
        "a@example.test,subscribed,Ann,A\n" +
        "b@example.test,Unsubscribed,Bo,B\n" +
        "nope,subscribed,,\n" +
        "A@EXAMPLE.TEST,subscribed,Ann,Again\n",
    );
    expect(r).toEqual({
      contacts: [{ email: "a@example.test", name: "Ann A" }],
      rows: 4,
      unsubscribedOnLuma: 1,
      notRegistered: 0,
      invalid: 1,
      duplicate: 1,
    });
  });
  it("names a file that isn't a Luma export", () => {
    expect(readLumaCsv("")).toEqual({ error: "That file is empty." });
    expect(readLumaCsv("name\nSam\n")).toHaveProperty("error");
  });
});

describe("planLumaImport", () => {
  it("our own unsubscribes win over everything; existing people are counted, not added", () => {
    const plan = planLumaImport(
      [{ email: "new@example.test", name: null }, { email: "have@example.test", name: null }, { email: "left@example.test", name: null }],
      new Set(["have@example.test", "left@example.test"]),
      new Set(["left@example.test"]),
    );
    expect(plan).toEqual({ add: [{ email: "new@example.test", name: null }], alreadyHave: 1, unsubscribedHere: 1 });
  });
});
