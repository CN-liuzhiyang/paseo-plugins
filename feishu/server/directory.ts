// Names for open_ids. Feishu events carry only IDs, and an ID means nothing to the person
// deciding who may use the bot, so everything a person sees shows a name. Names come from the
// members of chats the bot is in, and from the sender of a message.

export interface Directory {
  learn(openId: string, name: string): void;
  name(openId: string): string | null;
  /** Everyone in a chat the bot is in; asked from Feishu at most once every few minutes. */
  members(chatId: string): Promise<Array<{ openId: string; name: string }>>;
  /** The name of someone who just wrote `messageId` in `chatId`. */
  resolve(openId: string, hint: { chatId: string; messageId: string }): Promise<string | null>;
}

const MEMBERS_TTL_MS = 5 * 60_000;

export function createDirectory(sources: {
  chatMembers(chatId: string): Promise<Array<{ openId: string; name: string }>>;
  senderName(messageId: string): Promise<string | null>;
  log: (line: string) => void;
  now?: () => number;
}): Directory {
  const now = sources.now ?? Date.now;
  const names = new Map<string, string>();
  const chats = new Map<string, { at: number; members: Promise<Array<{ openId: string; name: string }>> }>();

  const learn = (openId: string, name: string) => {
    if (name.trim() !== "") names.set(openId, name.trim());
  };

  const members = (chatId: string) => {
    const cached = chats.get(chatId);
    if (cached && now() - cached.at < MEMBERS_TTL_MS) return cached.members;
    const asked = sources
      .chatMembers(chatId)
      .then((found) => {
        for (const member of found) learn(member.openId, member.name);
        return found;
      })
      .catch((error: unknown) => {
        // Not cached: the next ask tries again.
        chats.delete(chatId);
        sources.log(`members of ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
    chats.set(chatId, { at: now(), members: asked });
    return asked;
  };

  return {
    learn,
    name: (openId) => names.get(openId) ?? null,
    members,
    async resolve(openId, hint) {
      const known = names.get(openId);
      if (known) return known;
      const found = (await members(hint.chatId)).find((member) => member.openId === openId);
      if (found) return found.name;
      const name = await sources.senderName(hint.messageId).catch(() => null);
      if (name) learn(openId, name);
      return name;
    },
  };
}
