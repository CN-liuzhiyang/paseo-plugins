import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Two kinds of people can use the bot. Admins are the settings' `senders`, written from the
// settings screen: they can do everything, including approving what an agent asks and letting
// others in. Members are let in by an admin from a card in Feishu, which is where the person
// asking is, and where their name is known: nobody has to find an open_id. Members can talk to
// the agent; what it asks permission for still waits for an admin.
//
// The plugin's server can read its settings but not write them, so members are the plugin's
// own record, a file beside its audit log.

export interface Member {
  openId: string;
  name: string;
  /** The admin who let them in, and the name they went by then. */
  by: string;
  byName: string;
  /** The chat they were let in from. */
  chatId: string;
  at: number;
}

export interface People {
  members(): Promise<Member[]>;
  isMember(openId: string): Promise<boolean>;
  add(member: Member): Promise<void>;
  /** Whether anyone was removed. */
  remove(openId: string): Promise<boolean>;
}

export function createPeople(file: string): People {
  let cache: Member[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<Member[]> => {
    if (cache) return cache;
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return (cache = []);
      throw error;
    }
    // A file that does not parse is not read as empty: saving over it would lose everyone in it.
    const members = (JSON.parse(raw) as { members?: unknown }).members;
    if (!Array.isArray(members)) throw new Error(`${file} has no members list`);
    return (cache = members as Member[]);
  };

  const save = async (members: Member[]) => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ members }, null, 2), { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    cache = members;
  };

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    members: async () => [...(await load())],
    isMember: async (openId) => (await load()).some((member) => member.openId === openId),
    add: (member) =>
      serial(async () => {
        const members = await load();
        await save([...members.filter((known) => known.openId !== member.openId), member]);
      }),
    remove: (openId) =>
      serial(async () => {
        const members = await load();
        const kept = members.filter((member) => member.openId !== openId);
        if (kept.length === members.length) return false;
        await save(kept);
        return true;
      }),
  };
}

/** People in memory, for tests. */
export function memoryPeople(initial: Member[] = []): People {
  let members = [...initial];
  return {
    members: async () => [...members],
    isMember: async (openId) => members.some((member) => member.openId === openId),
    add: async (member) => {
      members = [...members.filter((known) => known.openId !== member.openId), member];
    },
    remove: async (openId) => {
      const before = members.length;
      members = members.filter((member) => member.openId !== openId);
      return members.length !== before;
    },
  };
}
