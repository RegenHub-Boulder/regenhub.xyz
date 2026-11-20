/**
 * Luma's CSV exports → the newsletter's interests list, without the Luma API (it needs Luma Plus).
 *
 * Two exports work: the calendar's people (Luma admin → People → Export: name, first_name, last_name, email,
 * subscription_status, …) and an event's guests (Manage event → Guests → Export: name, first_name, last_name,
 * email, approval_status, …). Only `email` is required. Guests only invited (never registered) or declined are left
 * out: they never asked to hear from us. Pure, so it's tested in node; the route
 * (/api/admin/newsletter/import-luma) reads the lists and writes the rows.
 */

/** RFC 4180 CSV: quoted fields with commas, quotes ("") and line breaks; CRLF or LF; a leading BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export interface LumaContact {
  email: string;
  name: string | null;
}

export interface LumaCsvRead {
  /** Distinct, valid, still-subscribed contacts, emails lowercased, in file order. */
  contacts: LumaContact[];
  /** Data rows in the file. */
  rows: number;
  /** Rows Luma marks unsubscribed from the calendar. */
  unsubscribedOnLuma: number;
  /** Guests export: people only invited (never registered) or declined by the host. */
  notRegistered: number;
  /** Rows with no usable email. */
  invalid: number;
  /** Rows repeating an email met earlier in the file. */
  duplicate: number;
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** A Luma export read into contacts, or why it isn't one. */
export function readLumaCsv(text: string): LumaCsvRead | { error: string } {
  const [header, ...data] = parseCsv(text);
  if (!header) return { error: "That file is empty." };
  const cols = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const col = (name: string) => cols.indexOf(name);
  const email = col("email");
  if (email < 0) return { error: "No email column: export the calendar's people or an event's guests from Luma as CSV." };
  const name = col("name");
  const first = col("first_name");
  const last = col("last_name");
  const status = col("subscription_status");
  const approval = col("approval_status");

  const out: LumaCsvRead = { contacts: [], rows: data.length, unsubscribedOnLuma: 0, notRegistered: 0, invalid: 0, duplicate: 0 };
  const seen = new Set<string>();
  for (const r of data) {
    const cell = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    if (/^unsubscribed$/i.test(cell(status))) {
      out.unsubscribedOnLuma++;
      continue;
    }
    if (/^(invited|declined)$/i.test(cell(approval))) {
      out.notRegistered++;
      continue;
    }
    const addr = cell(email).toLowerCase();
    if (!EMAIL_RE.test(addr)) {
      out.invalid++;
      continue;
    }
    if (seen.has(addr)) {
      out.duplicate++;
      continue;
    }
    seen.add(addr);
    const full = cell(name) || [cell(first), cell(last)].filter(Boolean).join(" ");
    out.contacts.push({ email: addr, name: full ? full.slice(0, 200) : null });
  }
  return out;
}

export interface LumaImportPlan {
  /** New to us: these become interests rows. */
  add: LumaContact[];
  /** Already a member or on the interests list. */
  alreadyHave: number;
  /** Unsubscribed from our newsletter (email_unsubscribes): never re-added. */
  unsubscribedHere: number;
}

/** Which contacts to add, given every email we already have and every email that unsubscribed here (lowercase). */
export function planLumaImport(contacts: LumaContact[], have: Set<string>, unsubscribed: Set<string>): LumaImportPlan {
  const plan: LumaImportPlan = { add: [], alreadyHave: 0, unsubscribedHere: 0 };
  for (const c of contacts) {
    if (unsubscribed.has(c.email)) plan.unsubscribedHere++;
    else if (have.has(c.email)) plan.alreadyHave++;
    else plan.add.push(c);
  }
  return plan;
}
