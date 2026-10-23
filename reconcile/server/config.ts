import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createCalendar, parseWindow, type Calendar, type CalendarYear, type Window } from "./time";

// The deployment's private half, read from the config directory the settings point at:
//   persons.json   who can be reached, in which time zone, when, how often
//   sources.json   where facts come from
//   policy.json    instance-wide limits
//   calendar/<year>.json   days off and make-up workdays
//   rules/*.mjs    the rules (rules.ts)
// Strict: an unknown key or a wrong type is an error with the file named, not a silent default.

const windowText = z.string().superRefine((value, ctx) => {
  try {
    parseWindow(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
  }
});

const personSchema = z
  .object({
    name: z.string().min(1),
    admin: z.boolean(),
    tz: z.string().min(1),
    quiet: z.object({ work: windowText, personal: windowText, family: windowText }).partial().strict(),
    pushPerDay: z.number().int().min(0).max(100),
    /**
     * Where a card for this person is also sent when it is raised: a channel some plugin registers
     * (server.deliver), an address that channel understands, and what to call it on the page.
     */
    notify: z.array(z.object({ channel: z.string().min(1), to: z.string().min(1), label: z.string().min(1).optional() }).strict()).default([]),
  })
  .strict();

const gcpSourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** What people call it, on the page and the list; the id is for the files. Absent: the page says only how many sources. */
    label: z.string().min(1).max(40).optional(),
    kind: z.literal("gcp"),
    /** The tracker's command-line tool, run without a shell: ["<node>", "<…>/cli.js"]. */
    command: z.array(z.string().min(1)).min(1),
    /** How the tool reaches the tracker: the gateway path it posts to, and the tool and target named in the body. */
    gateway: z.object({ path: z.string().min(1), tool: z.string().min(1), target: z.string().min(1) }).strict(),
    gcpHost: z.string().min(1),
    projectId: z.number().int(),
    /** How far back the first poll looks. */
    lookbackDays: z.number().int().min(1).max(90),
    /** Extra issue ids to follow even when they are not assigned to the user. */
    watch: z.array(z.number().int()),
    activeHours: windowText,
    everyMinutes: z.number().int().min(5),
    offHoursEveryMinutes: z.number().int().min(5),
    maxCallsPerHour: z.number().int().min(1),
    timeoutSeconds: z.number().int().min(5).max(300),
    domain: z.enum(["work", "personal", "family"]),
    /** Extra list columns -> the field name a full read gives them; a change in one is worth a full read. */
    columns: z.record(z.string(), z.string()).default({}),
    /** Watched issues missing from the list are read at most this often. */
    watchEveryMinutes: z.number().int().min(5).default(60),
    /** A hot issue is read again at least this often, so commits that reach a branch later are seen; 0: only when it changes. */
    refreshHotMinutes: z.number().int().min(0).default(0),
    /** Read the history to tell a person's change from an automation's. */
    journals: z.object({ automationNotePrefixes: z.array(z.string()) }).strict().optional(),
    /** Read the commits linked to an issue from version control. */
    changes: z
      .object({
        command: z.array(z.string().min(1)).min(1),
        timeoutSeconds: z.number().int().min(5).max(300),
        maxRevisions: z.number().int().min(1).max(100),
        /** A branch that did not have a revision yet is asked again after this long. */
        recheckMinutes: z.number().int().min(1).default(60),
        maxCallsPerPoll: z.number().int().min(1).default(300),
        repos: z.array(
          z
            .object({
              name: z.string().min(1),
              pattern: z.string().min(1),
              branches: z
                .array(
                  z
                    .object({
                      name: z.string().min(1),
                      url: z.string().min(1),
                      /**
                       * For a branch made by copying directories from another (not by merging): those
                       * directories, relative to url. A revision is looked up in the copy's history.
                       */
                      copied: z.array(z.string().min(1)).default([]),
                    })
                    .strict(),
                )
                .min(1),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
  })
  .strict();

const flagsSourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** What people call it, on the page and the list; the id is for the files. Absent: the page says only how many sources. */
    label: z.string().min(1).max(40).optional(),
    kind: z.literal("flags"),
    files: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), url: z.string().url(), labels: z.record(z.string(), z.string()) }).strict()).min(1),
    /** Top-level objects of each file whose entries are keys, e.g. ["switches"]; "" for the top level's own scalars. */
    sections: z.array(z.string()).min(1),
    /** The kind of the items it makes: "flags" files are where switch keys come from; another kind (a version file, say) is only read. */
    itemKind: z.string().regex(/^[a-z][a-z-]*$/).default("flags"),
    activeHours: windowText,
    everyMinutes: z.number().int().min(1),
    offHoursEveryMinutes: z.number().int().min(1),
    maxCallsPerHour: z.number().int().min(1),
    timeoutSeconds: z.number().int().min(1).max(120),
    domain: z.enum(["work", "personal", "family"]),
  })
  .strict();

export type GcpSourceConfig = z.output<typeof gcpSourceSchema>;
export type FlagsSourceConfig = z.output<typeof flagsSourceSchema>;
export type SourceConfig = GcpSourceConfig | FlagsSourceConfig;

const policySchema = z
  .object({
    /** The instance's own zone: for calendar days, source windows and the status line. */
    tz: z.string().min(1),
    /** A rules change that would create, cancel, change or reopen more commitments than this at once is held for a person. */
    ruleBreakerChanges: z.number().int().min(0),
    /** A source that has failed this long is reported as an evaluation candidate. */
    sourceDownHours: z.number().min(1),
    /** Cards asking the admin to confirm words said in a conversation, at most this many a day; they do not use up pushPerDay. */
    confirmPerDay: z.number().int().min(0).max(20).default(3),
    /**
     * Which items are judged each reconcile. The rest stay cold -- not judged, not shown, not
     * read again -- until something that matters about them changes.
     */
    hot: z
      .object({
        /** A person changed it within this many days. */
        recentDays: z.number().int().min(1),
        /** One of dateFields names a date within this many days either side of today. */
        dateWindowDays: z.number().int().min(0),
        dateFields: z.array(z.string()),
      })
      .strict()
      .default({ recentDays: 14, dateWindowDays: 14, dateFields: [] }),
    /**
     * Title fragments of items that are only containers or never end (an umbrella issue, a standing
     * one): such an item is hot only with an open commitment or on the watch list. It still counts
     * as a parent and as a sibling's parent.
     */
    coldTitles: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type Person = z.output<typeof personSchema> & { id: string; windows: Partial<Record<"work" | "personal" | "family", Window>> };
export type Policy = z.output<typeof policySchema>;

export interface Config {
  dir: string;
  persons: Record<string, Person>;
  sources: SourceConfig[];
  policy: Policy;
  calendar: Calendar;
  calendarYears: string[];
  rulesDir: string;
}

export class ConfigError extends Error {}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`${file}: ${(error as Error).message}`);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`${file}: ${issues}`);
  }
  return result.data;
}

/**
 * The config in dir. With `over`, a directory laid out the same way, each part it has (persons.json,
 * policy.json, calendar/, rules/) is read from it instead: a candidate change, previewed before it
 * is copied into dir.
 */
export function loadConfig(dir: string, over?: string): Config {
  if (!dir) throw new ConfigError("no config directory set (plugin settings: configDir)");
  if (!existsSync(dir)) throw new ConfigError(`config directory does not exist: ${dir}`);
  const pick = (name: string) => (over && existsSync(path.join(over, name)) ? path.join(over, name) : path.join(dir, name));
  const personsFile = pick("persons.json");
  const sourcesFile = path.join(dir, "sources.json");
  const policyFile = pick("policy.json");
  const rawPersons = parse(z.record(z.string().regex(/^[a-z0-9][a-z0-9:_-]*$/), personSchema), readJson(personsFile), personsFile);
  const persons: Record<string, Person> = {};
  for (const [id, person] of Object.entries(rawPersons)) {
    const windows: Person["windows"] = {};
    for (const [domain, text] of Object.entries(person.quiet)) windows[domain as keyof Person["windows"]] = parseWindow(text as string);
    persons[id] = { ...person, id, windows };
  }
  const sources = parse(z.array(z.discriminatedUnion("kind", [gcpSourceSchema, flagsSourceSchema])), readJson(sourcesFile), sourcesFile);
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) throw new ConfigError(`${sourcesFile}: source id "${source.id}" appears twice`);
    ids.add(source.id);
  }
  const policy = parse(policySchema, readJson(policyFile), policyFile);

  const calendarDir = pick("calendar");
  const years: Record<string, CalendarYear> = {};
  if (existsSync(calendarDir)) {
    for (const file of readdirSync(calendarDir).filter((f) => /^\d{4}\.json$/.test(f))) {
      const full = path.join(calendarDir, file);
      years[file.slice(0, 4)] = parse(
        z.object({ holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)), workdays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)) }).strict(),
        readJson(full),
        full,
      );
    }
  }
  return {
    dir,
    persons,
    sources,
    policy,
    calendar: createCalendar(years),
    calendarYears: Object.keys(years).sort(),
    rulesDir: pick("rules"),
  };
}
