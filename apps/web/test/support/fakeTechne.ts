/**
 * A fake of Techne's public read API (techne.computer/reference.html "Query"):
 * `pub.techne.draft.query.listRecords` and `getRecords` over an in-memory list
 * of records. Techne is a system outside this repo, so tests fake it at the
 * network edge (global fetch) and run every line of our own code.
 *
 * Supports the query grammar the site sends: `all`/`any`/`not` of `type`,
 * `author`, `subject`, `references` (`is`/`in`) and `start` (`after`/`before`), `order: "start"`.
 * `references` follows each type's registry query document: a membership's `subject` as
 * `at://{did}` (registry.getType pub.techne.draft.membership), an event's `locations[].uri`.
 */

class BadQuery extends Error {}

export interface FakeRecord {
  uri: string;
  cid?: string;
  value: Record<string, unknown>;
}

type Node = Record<string, unknown>;

function authorOf(uri: string) {
  return /^at:\/\/([^/]+)/.exec(uri)?.[1] ?? "";
}
function collectionOf(uri: string) {
  return uri.split("/")[3] ?? "";
}

function referencesOf(r: FakeRecord): string[] {
  const c = collectionOf(r.uri);
  if (c === "pub.techne.draft.membership") return typeof r.value.subject === "string" && r.value.subject.startsWith("did:") ? [`at://${r.value.subject}`] : [];
  if (c === "community.lexicon.calendar.event") {
    return ((r.value.locations as { uri?: string }[] | undefined) ?? []).map((l) => l.uri).filter((u): u is string => !!u);
  }
  return [];
}

function matches(r: FakeRecord, node: Node, now: number): boolean {
  if (Array.isArray(node.all)) return (node.all as Node[]).every((n) => matches(r, n, now));
  if (Array.isArray(node.any)) return (node.any as Node[]).some((n) => matches(r, n, now));
  if (node.not) return !matches(r, node.not as Node, now);
  const entries = Object.entries(node) as [string, Record<string, unknown>][];
  // The real platform refuses these (400 "start takes exactly one operator"); so does the fake.
  if (entries.length !== 1 || Object.keys(entries[0][1]).length !== 1) throw new BadQuery("a leaf names one role and one operator");
  const [[role, cond]] = entries;
  if (role === "references") {
    const refs = referencesOf(r);
    if (cond.is !== undefined) return refs.includes(String(cond.is));
    if (Array.isArray(cond.in)) return refs.some((x) => (cond.in as string[]).includes(x));
    return false;
  }
  const value =
    role === "type"
      ? collectionOf(r.uri)
      : role === "author"
        ? authorOf(r.uri)
        : role === "subject"
          ? (r.value.subject as { uri?: string } | undefined)?.uri
          : role === "start"
            ? (r.value.startsAt as string | undefined)
            : undefined;
  if (value === undefined) return false;
  if (cond.is !== undefined) return value === cond.is;
  if (Array.isArray(cond.in)) return (cond.in as string[]).includes(value);
  const t = Date.parse(value);
  const at = (v: unknown) => (v === "$now" ? now : Date.parse(String(v)));
  if (cond.after !== undefined && !(t > at(cond.after))) return false;
  if (cond.before !== undefined && !(t < at(cond.before))) return false;
  return cond.after !== undefined || cond.before !== undefined;
}

export interface FakeTechne {
  records: FakeRecord[];
  calls: URL[];
  /** Answer every call with this status instead (an outage). */
  failWith: number | null;
  fetch: typeof fetch;
}

export function fakeTechne(records: FakeRecord[] = []): FakeTechne {
  const self: FakeTechne = {
    records,
    calls: [],
    failWith: null,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      self.calls.push(url);
      if (self.failWith) return new Response("{}", { status: self.failWith });
      const view = (r: FakeRecord) => ({
        uri: r.uri,
        cid: r.cid ?? "bafyfake",
        author: authorOf(r.uri),
        collection: collectionOf(r.uri),
        value: r.value,
        source: "public",
      });
      if (url.pathname.endsWith("/pub.techne.draft.query.listRecords")) {
        const q = JSON.parse(url.searchParams.get("query") ?? "{}") as { where: Node; order?: string };
        let rows: FakeRecord[];
        try {
          rows = self.records.filter((r) => matches(r, q.where, Date.now()));
        } catch (err) {
          if (err instanceof BadQuery) return Response.json({ error: "InvalidRequest", message: err.message }, { status: 400 });
          throw err;
        }
        if (q.order === "start") {
          rows = rows
            .filter((r) => r.value.startsAt)
            .sort((a, b) => String(a.value.startsAt).localeCompare(String(b.value.startsAt)));
        }
        return Response.json({ records: rows.map(view) });
      }
      if (url.pathname.endsWith("/pub.techne.draft.query.getRecords")) {
        const uris = url.searchParams.getAll("uris");
        return Response.json({ records: self.records.filter((r) => uris.includes(r.uri)).map(view) });
      }
      return new Response(JSON.stringify({ error: "MethodNotImplemented" }), { status: 501 });
    }) as typeof fetch,
  };
  return self;
}
