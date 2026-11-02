import * as fs from "node:fs";
import * as config from "./Config.ts";
import { UNII } from "./View.ts";
import { write_whole } from "./Write.ts";

export type Personality = { id: string; name: string; pronouns: string; text: string };

export type Link = { from: string; to: string; since: string | null };

type Entry = Link & { op: "link" | "unlink"; at: string };

type Kept = { at: string; why: string };

type Shelved = { dir: string; name: string; at: string };

const DIR      = config.DIR + "/personalities";
const ACTIVE   = DIR + "/active";
const FILE     = "/personality.md";
const NAME_MAX = 40;
const TEXT_MAX = 64 * 1024;
const PRONOUNS = /^\p{L}+\/\p{L}+$/u;
const HEAD     = "# Who you are\n\n";
const JOURNAL  = DIR + "/links.jsonl";
const SEEN     = "/links.seen";
const NEWS     = "/news.txt";
const VERSIONS = "/versions";
const CHECKS   = "/checkpoints";
const ARCHIVE  = DIR + "/.archive";
const STAMP    = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/;
const DAY_LOG  = /\/(main|tree)\/(\d{4}-\d{2}-\d{2})\.jsonl$/;
const KEPT_AS  = /\/docs\/(images|media)\//;

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

  export function home(id: string): string {
    return DIR + "/" + id;
  }

  export function chat(id: string): string {
    return id === BUILT_IN.id ? config.DIR + "/chat" : Personality.home(id) + "/chat";
  }

  export function list(): Personality[] {
    const ids = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((id) => id !== BUILT_IN.id && fs.existsSync(Personality.home(id) + FILE)) : [];
    return [BUILT_IN.id, ...ids.sort()].flatMap((id) => Personality.read(id) ?? []);
  }

  export function read(id: string): Personality | null {
    const file = Personality.home(id) + FILE;
    if (!/^[a-z0-9-]+$/.test(id) || !fs.existsSync(file)) {
      return id === BUILT_IN.id ? BUILT_IN : null;
    }
    return Personality.parse(id, fs.readFileSync(file, "utf8"));
  }

  export function parse(id: string, file: string): Personality {
    const data = file.replace(/\r\n/g, "\n");
    const [, head = "", text = data] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(data) ?? [];
    const field = (key: string) => new RegExp("^" + key + ":[ \\t]*(.*)$", "m").exec(head)?.[1]?.trim() ?? "";
    return { id, name: field("name") || BUILT_IN.name, pronouns: field("pronouns") || BUILT_IN.pronouns, text: text.trim() };
  }

  // a changed file keeps the one it replaces in versions/
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
    const [file, text] = [Personality.home(p.id) + FILE, "---\nname: " + p.name + "\npronouns: " + p.pronouns + "\n---\n\n" + p.text + "\n"];
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== text) {
      fs.mkdirSync(Personality.home(p.id) + VERSIONS, { recursive: true });
      fs.copyFileSync(file, Personality.home(p.id) + VERSIONS + "/" + Personality.stamp() + ".md");
    }
    fs.mkdirSync(Personality.home(p.id), { recursive: true });
    write_whole(file, text);
    if (p.id === now.id) {
      now = p;
    }
    return p;
  }

  export function free_id(name: string): string {
    const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "personality";
    let id = base;
    for (let k = 2; id === BUILT_IN.id || fs.existsSync(Personality.home(id)); k++) {
      id = base + "-" + k;
    }
    return id;
  }

  export function stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  export function when(at: string): string {
    return at.slice(0, 10) + " " + at.slice(11, 16).replace("-", ":") + " UTC";
  }

  export function versions(id: string): Personality[] {
    const dir = Personality.home(id) + VERSIONS;
    const ats = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => STAMP.test(f.replace(/\.md$/, ""))).sort().reverse() : [];
    return ats.map((f) => ({ ...Personality.parse(id, fs.readFileSync(dir + "/" + f, "utf8")), id: f.replace(/\.md$/, "") }));
  }

  export function revert(id: string, at: string): Personality {
    const file = Personality.home(id) + VERSIONS + "/" + at + ".md";
    if (!STAMP.test(at) || !fs.existsSync(file)) {
      throw new Error("No version " + at + " of " + id + ".");
    }
    return Personality.save({ ...Personality.parse(id, fs.readFileSync(file, "utf8")), id });
  }

  export function checkpoints(id: string): Kept[] {
    const dir = Personality.home(id) + CHECKS;
    const ats = fs.existsSync(dir) ? fs.readdirSync(dir).filter((at) => STAMP.test(at)).sort().reverse() : [];
    return ats.map((at) => ({ at, why: fs.existsSync(dir + "/" + at + ".why") ? fs.readFileSync(dir + "/" + at + ".why", "utf8").trim() : "" }));
  }

  export function checkpoint(id: string, why: string): void {
    const from = Personality.chat(id);
    if (!fs.existsSync(from)) {
      return;
    }
    const at = Personality.stamp();
    Personality.copy(from, Personality.home(id) + CHECKS + "/" + at);
    write_whole(Personality.home(id) + CHECKS + "/" + at + ".why", why + "\n");
  }

  // the chat as it is now becomes a checkpoint, and a copy of the one asked
  // for takes its place
  export function rewind(id: string, at: string): void {
    const p = Personality.read(id);
    const kept = Personality.home(id) + CHECKS + "/" + at;
    if (p === null || !STAMP.test(at) || !fs.existsSync(kept)) {
      throw new Error("No checkpoint " + at + " of " + id + ".");
    }
    if (id === now.id) {
      throw new Error(p.name + " is in use: switch to another personality first.");
    }
    const [chat, aside] = [Personality.chat(id), Personality.stamp()];
    if (fs.existsSync(chat)) {
      fs.renameSync(chat, Personality.home(id) + CHECKS + "/" + aside);
      write_whole(Personality.home(id) + CHECKS + "/" + aside + ".why", "before going back to " + Personality.when(at) + "\n");
    }
    Personality.copy(kept, chat);
    const seen = Personality.journal().filter((e) => e.at.replace(/[:.]/g, "-") < at).length;
    write_whole(Personality.home(id) + SEEN, seen + "\n");
    Personality.tell(id, "The user brought " + p.name + "'s memory back to its checkpoint of " + Personality.when(at) + ". The memory as it was just before is kept as a checkpoint too.");
  }

  // days' logs before today and media never change, so a copy links them;
  // indexes are left out, rebuilt from the logs
  export function copy(from: string, to: string): void {
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const [a, b] = [from + "/" + e.name, to + "/" + e.name];
      if (e.isDirectory()) {
        Personality.copy(a, b);
        continue;
      }
      if (e.name.endsWith(".index") || e.name.endsWith(".new")) {
        continue;
      }
      const day = DAY_LOG.exec(a)?.[2];
      if ((day !== undefined && day < today) || KEPT_AS.test(a)) {
        try {
          fs.linkSync(a, b);
          continue;
        } catch {}
      }
      fs.copyFileSync(a, b);
    }
  }

  export function archive(id: string): void {
    const p = Personality.read(id);
    if (p === null) {
      throw new Error("No personality " + id + ".");
    }
    if (id === BUILT_IN.id) {
      throw new Error(p.name + " is built in, and stays.");
    }
    if (id === now.id) {
      throw new Error(p.name + " is in use: switch to another personality first.");
    }
    for (const l of Personality.links().filter((l) => l.from === id || l.to === id)) {
      Personality.unlink(l.from, l.to);
    }
    fs.mkdirSync(ARCHIVE, { recursive: true });
    fs.renameSync(Personality.home(id), ARCHIVE + "/" + id + "@" + Personality.stamp());
  }

  export function archived(): Shelved[] {
    const dirs = fs.existsSync(ARCHIVE) ? fs.readdirSync(ARCHIVE).filter((d) => fs.existsSync(ARCHIVE + "/" + d + FILE)).sort().reverse() : [];
    return dirs.map((dir) => ({ dir, name: Personality.parse("", fs.readFileSync(ARCHIVE + "/" + dir + FILE, "utf8")).name, at: dir.split("@")[1] ?? "" }));
  }

  export function unarchive(dir: string): Personality {
    const [base = "", at = ""] = dir.split("@");
    if (!/^[a-z0-9-]+$/.test(base) || !STAMP.test(at) || !fs.existsSync(ARCHIVE + "/" + dir + FILE)) {
      throw new Error("No archived personality " + dir + ".");
    }
    const id = fs.existsSync(Personality.home(base)) ? Personality.free_id(base) : base;
    fs.renameSync(ARCHIVE + "/" + dir, Personality.home(id));
    return Personality.read(id) ?? BUILT_IN;
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

  export function tell(id: string, text: string): void {
    fs.mkdirSync(Personality.home(id), { recursive: true });
    fs.appendFileSync(Personality.home(id) + NEWS, text.replace(/\n/g, " ") + "\n");
  }

  // what id hasn't been told yet: its news, then the journal's entries about it
  export function news(id: string): string[] {
    const [seen_at, news_at] = [Personality.home(id) + SEEN, Personality.home(id) + NEWS];
    const all  = Personality.journal();
    const seen = fs.existsSync(seen_at) ? Number(fs.readFileSync(seen_at, "utf8")) || 0 : 0;
    if (seen !== all.length) {
      fs.mkdirSync(Personality.home(id), { recursive: true });
      write_whole(seen_at, all.length + "\n");
    }
    const told = all.slice(seen).filter((e) => e.from === id || e.to === id).map(Personality.told);
    const rest = fs.existsSync(news_at) ? fs.readFileSync(news_at, "utf8").split("\n").filter((line) => line !== "") : [];
    fs.rmSync(news_at, { force: true });
    return [...rest, ...told];
  }

  export function told(e: Entry): string {
    const shelf = Personality.archived();
    const [from, to] = [e.from, e.to].map((id) => Personality.read(id)?.name ?? shelf.find((a) => a.dir.startsWith(id + "@"))?.name ?? id);
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
