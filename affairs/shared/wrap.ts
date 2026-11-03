// How every piece of text in the panel and the cards is laid out. One place, so a long title, a long run of letters with no
// spaces, a web address or a line of Chinese and English mixed all wrap inside the box they are in, instead of running out of
// it and being cut off. `client/text.tsx` puts this on every Text; a test keeps any Text from being used without it.

/** minWidth 0 and flexShrink 1 let a text next to something else (a time, a button) give way instead of pushing it out; the two word rules break a line anywhere it has to, which is what a string with no spaces needs. */
export const WRAP = { flexShrink: 1, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" } as const;
