import * as fs from "node:fs";
import * as config from "./Config.ts";
import { UNII } from "./View.ts";
import { write_whole } from "./Write.ts";

export type Personality = { id: string; name: string; pronouns: string; text: string };

export type Link = { from: string; to: string; since: string | null };

type Entry = Link & { op: "link" | "unlink"; at: string };

const DIR      = config.DIR + "/personalities";
const ACTIVE   = DIR + "/active";
const FILE     = "/personality.md";
const NAME_MAX = 40;
const TEXT_MAX = 64 * 1024;
const PRONOUNS = /^\p{L}+\/\p{L}+$/u;
const HEAD     = "# Who you are\n\n";
const JOURNAL  = DIR + "/links.jsonl";
const SEEN     = "/links.seen";

export const PRONOUN_SETS = ["she/her", "he/him", "they/them", "it/its"];

export const BUILT_IN: Personality = { ...UNII, pronouns: "it/its", text: "" };

let now = BUILT_IN;

export namespace Personality {

  export function load(): Personality {
    const id = fs.existsSync(ACTIVE) ? fs.readFileSync(ACTIVE, "utf8").trim() : BUILT_IN.id;
    now = Personality.read(id) ?? BUILT_IN;
    return now;
  }

  export function active(): Personality {
    return now;
  }

  export function choose(id: string): Personality {
    const next = Personality.read(id);
    if (next === null) {
      throw new Error("No personality " + id + ".");
    }
    fs.mkdirSync(DIR, { recursive: true });
    write_whole(ACTIVE, next.id === BUILT_IN.id ? null : next.id + "\n");
    now = next;
    return now;
  }

  export function chat(id: string): string {
    return id === BUILT_IN.id ? config.DIR + "/chat" : DIR + "/" + id + "/chat";
  }

  export function list(): Personality[] {
    const ids = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((id) => id !== BUILT_IN.id && fs.existsSync(DIR + "/" + id + FILE)) : [];
    return [BUILT_IN.id, ...ids.sort()].flatMap((id) => Personality.read(id) ?? []);
  }

  export function read(id: string): Personality | null {
    const file = DIR + "/" + id + FILE;
    if (!/^[a-z0-9-]+$/.test(id) || !fs.existsSync(file)) {
      return id === BUILT_IN.id ? BUILT_IN : null;
    }
    const data = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const [, head = "", text = data] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(data) ?? [];
    const field = (key: string) => new RegExp("^" + key + ":[ \\t]*(.*)$", "m").exec(head)?.[1]?.trim() ?? "";
    return { id, name: field("name") || BUILT_IN.name, pronouns: field("pronouns") || BUILT_IN.pronouns, text: text.trim() };
  }

  export function save(given: Omit<Personality, "id"> & { id?: string }): Personality {
    const p = { ...given, id: given.id ?? Personality.free_id(given.name), name: given.name.trim(), pronouns: given.pronouns.trim(), text: given.text.trim() };
    if (Personality.read(p.id) === null && given.id !== undefined) {
      throw new Error("No personality " + p.id + ".");
    }
    if (p.name === "" || p.name.length > NAME_MAX || /[\n{}]/.test(p.name)) {
      throw new Error("A name is 1 to " + NAME_MAX + " characters, on one line, without { or }.");
    }
    if (!PRONOUNS.test(p.pronouns)) {
      throw new Error("Pronouns are written like " + PRONOUN_SETS.join(", ") + ".");
    }
    if (Buffer.byteLength(p.text) > TEXT_MAX) {
      throw new Error("A personality holds at most 64 KB.");
    }
    fs.mkdirSync(DIR + "/" + p.id, { recursive: true });
    write_whole(DIR + "/" + p.id + FILE, "---\nname: " + p.name + "\npronouns: " + p.pronouns + "\n---\n\n" + p.text + "\n");
    if (p.id === now.id) {
      now = p;
    }
    return p;
  }

  export function free_id(name: string): string {
    const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "personality";
    let id = base;
    for (let k = 2; id === BUILT_IN.id || fs.existsSync(DIR + "/" + id); k++) {
      id = base + "-" + k;
    }
    return id;
  }

  export function journal(): Entry[] {
    const lines = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, "utf8").split("\n") : [];
    return lines.flatMap((line) => {
      try {
        return line === "" ? [] : [JSON.parse(line) as Entry];
      } catch {
        return [];
      }
    });
  }

  export function links(): Link[] {
    const now = new Map<string, Link>();
    for (const { op, from, to, since } of Personality.journal()) {
      if (op === "link") {
        now.set(from + " " + to, { from, to, since });
      } else {
        now.delete(from + " " + to);
      }
    }
    return [...now.values()].filter((l) => Personality.read(l.from) !== null && Personality.read(l.to) !== null);
  }

  export function link(from: string, to: string, since: string | null): void {
    if (from === to) {
      throw new Error("A personality reads its own memory already.");
    }
    for (const id of [from, to]) {
      if (Personality.read(id) === null) {
        throw new Error("No personality " + id + ".");
      }
    }
    if (since !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || isNaN(Date.parse(since)))) {
      throw new Error("A link's start is a date, like 2026-11-02.");
    }
    Personality.write({ op: "link", from, to, since, at: new Date().toISOString() });
  }

  export function unlink(from: string, to: string): void {
    if (!Personality.links().some((l) => l.from === from && l.to === to)) {
      throw new Error("No link from " + from + " to " + to + ".");
    }
    Personality.write({ op: "unlink", from, to, since: null, at: new Date().toISOString() });
  }

  export function write(entry: Entry): void {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(JOURNAL, JSON.stringify(entry) + "\n");
  }

  // the journal's entries about id it hasn't been told of yet
  export function unseen(id: string): Entry[] {
    const file = DIR + "/" + id + SEEN;
    const all  = Personality.journal();
    const seen = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) || 0 : 0;
    if (seen !== all.length) {
      fs.mkdirSync(DIR + "/" + id, { recursive: true });
      write_whole(file, all.length + "\n");
    }
    return all.slice(seen).filter((e) => e.from === id || e.to === id);
  }

  export function told(e: Entry): string {
    const [from, to] = [e.from, e.to].map((id) => Personality.read(id)?.name ?? id);
    return e.op === "link"
      ? "The user let " + to + " read " + from + "'s memory, read-only" + (e.since === null ? "" : ", from " + e.since + " on") + "."
      : "The user stopped " + to + " reading " + from + "'s memory.";
  }

  export function fill(text: string): string {
    return text.replaceAll("{name}", now.name).replaceAll("{pronouns}", now.pronouns);
  }

  export function system(prompt: string): string {
    return Personality.fill(prompt) + (now.text === "" ? "" : "\n\n" + HEAD + now.text);
  }
}
