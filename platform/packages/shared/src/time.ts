/**
 * THE WORKSPACE CLOCK (Build docs/30).
 *
 * Every time a person reads in the CRM is rendered in ONE zone: the
 * workspace's `organizations.reporting_timezone` (migration 0090). Not the
 * viewer's browser, not the server's, not a hard-coded Asia/Kolkata. Two
 * colleagues in different cities looking at the same call must see the same
 * day and hour, or they end up arguing about whether a follow-up is overdue.
 *
 * ── WHY THIS FILE FORMATS BY HAND ───────────────────────────────────────────
 *
 * `toLocaleString()` is unstable on three axes at once: the ZONE (server UTC vs
 * browser local), the LOCALE (whatever the machine is set to), and the ICU
 * build (month abbreviations, a narrow no-break space before "pm" in newer
 * ICU). React then throws a hydration mismatch whenever the server and the
 * browser disagree, which they routinely do.
 *
 * So the zone is always explicit, and only NUMERIC parts are read from
 * `Intl.DateTimeFormat#formatToParts` - digits are the one thing every ICU
 * build agrees on. Every word (month, weekday, am/pm) comes from the fixed
 * tables below. The same instant in the same zone therefore formats to the
 * same string on any machine, which is what lets a Server Component and a
 * Client Component print a time without a mismatch or a flash.
 *
 * ── DATES ARE NOT INSTANTS ──────────────────────────────────────────────────
 *
 * A `YYYY-MM-DD` value (a task's due_on, an invoice's due date, a report's
 * from/to) is a calendar date and is NEVER converted through a zone - a task
 * due Thursday is due Thursday everywhere. Format those with formatDateKey,
 * never by building a Date from them (`new Date("2026-09-22")` is midnight
 * UTC, which is the 21st anywhere west of Greenwich).
 */

/** The deployment default, and the same fallback the SQL helpers use (0095, 0132). */
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

export type Instant = Date | string | number;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** ISO order: index 0 is Monday, so `WEEKDAYS[weekday - 1]`. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * ICU still speaks the pre-2008 names for a handful of zones - Node 24 lists
 * `Asia/Calcutta`, not `Asia/Kolkata`, and resolves "Asia/Kolkata" BACK to
 * "Asia/Calcutta". The database stores, and people search for, the current
 * IANA name. Every id that enters or leaves this module is folded through here
 * so the two spellings of one zone can never be treated as two zones.
 */
const CURRENT_NAME: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "America/Godthab": "America/Nuuk",
  "America/Coral_Harbour": "America/Atikokan",
  "Africa/Asmera": "Africa/Asmara",
  "Etc/UTC": "UTC",
  "Etc/GMT": "UTC",
  GMT: "UTC",
};

const LEGACY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(CURRENT_NAME)
    .filter(([legacy]) => legacy.includes("/") && !legacy.startsWith("Etc/"))
    .map(([legacy, current]) => [current, legacy]),
);

// ── validation ──────────────────────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** The numeric-parts formatter for a zone, or null when the zone is unknown. */
function numericFormatter(zone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(zone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      // h23, not hour12:false - older ICU builds render midnight as "24" under
      // hour12:false, which would put 00:30 at the end of the previous day.
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(zone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** True when both this runtime's Intl knows the zone and it is not an empty string. */
export function isValidTimeZone(zone: string | null | undefined): zone is string {
  return typeof zone === "string" && zone.trim().length > 0 && numericFormatter(zone.trim()) !== null;
}

/**
 * The current IANA spelling of a zone, or null when it is not a zone at all.
 * Case-insensitive on input ("asia/kolkata" -> "Asia/Kolkata"), because Intl
 * is, and a hand-typed value should not fail on its capitals.
 */
export function canonicalTimeZone(zone: string | null | undefined): string | null {
  if (!isValidTimeZone(zone)) return null;
  const resolved = numericFormatter(zone.trim())!.resolvedOptions().timeZone;
  return CURRENT_NAME[resolved] ?? resolved;
}

/**
 * Every spelling a database might know this zone by, preferred first. An older
 * tzdata on the Postgres side can lack a 2022 rename (Europe/Kyiv) while
 * knowing the old one, so the API offers both and stores whichever the
 * database accepts.
 */
export function timeZoneSpellings(zone: string): string[] {
  const current = canonicalTimeZone(zone) ?? zone;
  const legacy = LEGACY_NAME[current];
  return legacy ? [current, legacy] : [current];
}

/** The zone to render in: the workspace's if it is usable, else the default. */
export function resolveTimeZone(zone: string | null | undefined): string {
  return canonicalTimeZone(zone) ?? DEFAULT_TIME_ZONE;
}

// ── parts ───────────────────────────────────────────────────────────────────

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
}

function toDate(instant: Instant): Date | null {
  const date = instant instanceof Date ? instant : new Date(instant);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The wall-clock reading of `instant` in `zone`. Null for an unparseable instant. */
export function zonedParts(instant: Instant, zone: string): ZonedParts | null {
  const date = toDate(instant);
  if (!date) return null;
  const formatter = numericFormatter(zone) ?? numericFormatter(DEFAULT_TIME_ZONE)!;
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  const year = out.year!;
  const month = out.month!;
  const day = out.day!;
  // Weekday by calendar arithmetic, not from Intl's text - see the header.
  const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    year,
    month,
    day,
    hour: out.hour === 24 ? 0 : out.hour!,
    minute: out.minute!,
    second: out.second!,
    weekday: sundayFirst === 0 ? 7 : sundayFirst,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of the day `instant` falls on in `zone`. */
export function dayKeyIn(instant: Instant, zone: string): string | null {
  const p = zonedParts(instant, zone);
  return p ? `${p.year}-${pad(p.month)}-${pad(p.day)}` : null;
}

/** Today in `zone` - the browser's twin of SQL `org_reporting_today()`. */
export function todayIn(zone: string, now: Instant = Date.now()): string {
  return dayKeyIn(now, zone) ?? dayKeyIn(now, DEFAULT_TIME_ZONE)!;
}

/** `YYYY-MM-DD` shifted by whole days. Calendar arithmetic; no zone involved. */
export function shiftDateKey(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ── offsets and wall times ──────────────────────────────────────────────────

/** Minutes the zone is ahead of UTC at `at` (330 for IST). DST-correct for that instant. */
export function utcOffsetMinutes(zone: string, at: Instant = Date.now()): number {
  const date = toDate(at) ?? new Date();
  const p = zonedParts(date, zone)!;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60_000);
}

/** 330 -> "UTC+05:30", -300 -> "UTC-05:00", 0 -> "UTC+00:00". */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The instant a person meant by a wall time typed in `zone` - the value of a
 * `datetime-local` input ("2026-09-22T18:00"), read as the workspace's clock
 * rather than the laptop's.
 *
 * Two passes, because the offset to subtract is the one in force AT the
 * answer, which is not known until the answer is. In a DST gap (a wall time
 * that never happened, 02:30 on a spring-forward night) this lands an hour
 * later, on the first real instant; in an overlap it takes the first reading.
 */
export function wallTimeToInstant(wallTime: string, zone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wallTime.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  if (Number.isNaN(guess)) return null;
  // The two offsets that can be in force near this wall time give two
  // candidate instants. Whichever reads back as the typed time is the answer;
  // when NEITHER does, the time fell in a DST gap and the later candidate is
  // the first real instant after it (02:30 on a spring-forward night -> 03:30).
  const first = guess - utcOffsetMinutes(zone, guess) * 60_000;
  const second = guess - utcOffsetMinutes(zone, first) * 60_000;
  const typed = `${y}-${mo}-${d}T${h}:${mi}`;
  const exact = [second, first].find((candidate) => instantToWallTime(candidate, zone) === typed);
  return new Date(exact ?? Math.max(first, second)).toISOString();
}

/** The `datetime-local` value ("YYYY-MM-DDTHH:mm") for an instant, in `zone`. */
export function instantToWallTime(instant: Instant, zone: string): string {
  const p = zonedParts(instant, zone);
  if (!p) return "";
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// ── formatting (Build docs/30 R7) ───────────────────────────────────────────

function clock(p: ZonedParts): string {
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${pad(p.minute)} ${p.hour < 12 ? "am" : "pm"}`;
}

/** "22 Sep 2026" */
export function formatDate(instant: Instant, zone: string): string {
  const p = zonedParts(instant, zone);
  return p ? `${p.day} ${MONTHS[p.month - 1]} ${p.year}` : "-";
}

/** "22 Sep" */
export function formatDayMonth(instant: Instant, zone: string): string {
  const p = zonedParts(instant, zone);
  return p ? `${p.day} ${MONTHS[p.month - 1]}` : "-";
}

/** "Tue 22 Sep" */
export function formatWeekdayDate(instant: Instant, zone: string): string {
  const p = zonedParts(instant, zone);
  return p ? `${WEEKDAYS[p.weekday - 1]} ${p.day} ${MONTHS[p.month - 1]}` : "-";
}

/** "2:30 pm" */
export function formatTime(instant: Instant, zone: string): string {
  const p = zonedParts(instant, zone);
  return p ? clock(p) : "-";
}

/** "22 Sep 2026, 2:30 pm" */
export function formatDateTime(instant: Instant, zone: string): string {
  const p = zonedParts(instant, zone);
  return p ? `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${clock(p)}` : "-";
}

/**
 * "just now" / "5m ago" / "3h ago" / "2d ago", and the date once it is a month
 * old - the wording `relativeTime` has always used. Future instants read "in
 * 5m". Depends on `now`, so a caller rendering on both sides of hydration must
 * expect the minute to differ (see org-time.tsx).
 */
export function formatRelative(instant: Instant, zone: string, now: Instant = Date.now()): string {
  const date = toDate(instant);
  const reference = toDate(now);
  if (!date || !reference) return "-";
  const diff = reference.getTime() - date.getTime();
  const future = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60_000);
  const say = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`);
  if (mins < 1) return "just now";
  if (mins < 60) return say(mins, "m");
  const hours = Math.round(mins / 60);
  if (hours < 24) return say(hours, "h");
  const days = Math.round(hours / 24);
  if (days < 30) return say(days, "d");
  return formatDate(date, zone);
}

/** A calendar date `YYYY-MM-DD` as "22 Sep 2026" - no zone, by design (see the header). */
export function formatDateKey(dateKey: string | null | undefined, opts: { year?: boolean } = {}): string {
  if (!dateKey) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateKey);
  if (!m) return "-";
  const day = Number(m[3]);
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return "-";
  return opts.year === false ? `${day} ${month}` : `${day} ${month} ${m[1]}`;
}

/** "Tue" for a calendar date `YYYY-MM-DD`. */
export function weekdayOfDateKey(dateKey: string): string {
  const d = new Date(`${dateKey.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return WEEKDAYS[d === 0 ? 6 : d - 1] ?? "";
}

/** ISO weekday (1 = Monday) to "Mon". */
export function weekdayName(isoWeekday: number): string {
  return WEEKDAYS[isoWeekday - 1] ?? "";
}

/** "13:00-14:00" style hour band, 24-hour so a grid of hours reads as one scale. */
export function formatHourBand(hour: number): string {
  return `${pad(hour)}:00–${pad((hour + 1) % 24)}:00`;
}

// ── naming a zone ───────────────────────────────────────────────────────────

/**
 * Abbreviations people actually say, for zones that never change offset - so
 * the label is true all year. DST zones are named by offset instead ("UTC-04:00"
 * in summer, "UTC-05:00" in winter), because printing "EST" in July is wrong
 * and ICU's own abbreviations differ between Node and browsers.
 */
const FIXED_ABBREVIATION: Record<string, string> = {
  "Asia/Kolkata": "IST",
  "Asia/Dubai": "GST",
  "Asia/Singapore": "SGT",
  "Asia/Karachi": "PKT",
  "Asia/Kathmandu": "NPT",
  "Asia/Dhaka": "BST",
  "Asia/Tokyo": "JST",
  "Asia/Seoul": "KST",
  "Asia/Hong_Kong": "HKT",
  "Asia/Shanghai": "CST",
  "Asia/Manila": "PHT",
  "Asia/Jakarta": "WIB",
  "Asia/Bangkok": "ICT",
  "Asia/Riyadh": "AST",
  "Africa/Nairobi": "EAT",
  "Africa/Lagos": "WAT",
  "Africa/Johannesburg": "SAST",
  UTC: "UTC",
};

/** "Kolkata" from "Asia/Kolkata", "Buenos Aires" from "America/Argentina/Buenos_Aires". */
export function timeZoneCity(zone: string): string {
  const id = canonicalTimeZone(zone) ?? zone;
  if (id === "UTC") return "UTC";
  return (id.split("/").pop() ?? id).replace(/_/g, " ");
}

/** "Asia", "America", ... - the first path segment; "UTC" for UTC. */
export function timeZoneRegion(zone: string): string {
  const id = canonicalTimeZone(zone) ?? zone;
  return id.includes("/") ? id.split("/")[0]! : "UTC";
}

export function timeZoneAbbreviation(zone: string): string | null {
  return FIXED_ABBREVIATION[canonicalTimeZone(zone) ?? zone] ?? null;
}

/** "IST · UTC+05:30" or "UTC-04:00" - what a page prints beside a time. */
export function timeZoneShortLabel(zone: string, at: Instant = Date.now()): string {
  const offset = formatUtcOffset(utcOffsetMinutes(zone, at));
  const abbr = timeZoneAbbreviation(zone);
  return abbr && abbr !== "UTC" ? `${abbr} · ${offset}` : offset;
}

/** "Kolkata (IST · UTC+05:30)" */
export function timeZoneLabel(zone: string, at: Instant = Date.now()): string {
  return `${timeZoneCity(zone)} (${timeZoneShortLabel(zone, at)})`;
}

// ── the picker's catalogue ──────────────────────────────────────────────────

/**
 * What people type that is not in the IANA id. Countries, the big cities a
 * zone is not named after, and spoken abbreviations - weighted to the markets
 * this product sells into. A zone missing from here is still findable by its
 * city, region and offset; this only adds the words people use instead.
 */
const KEYWORDS: Record<string, string[]> = {
  "Asia/Kolkata": ["India", "IST", "Mumbai", "Delhi", "New Delhi", "Bengaluru", "Bangalore", "Chennai", "Hyderabad", "Pune", "Ahmedabad", "Calcutta"],
  "Asia/Dubai": ["United Arab Emirates", "UAE", "GST", "Gulf", "Abu Dhabi", "Sharjah"],
  "Asia/Muscat": ["Oman"],
  "Asia/Riyadh": ["Saudi Arabia", "KSA", "Jeddah"],
  "Asia/Qatar": ["Qatar", "Doha"],
  "Asia/Bahrain": ["Bahrain", "Manama"],
  "Asia/Kuwait": ["Kuwait"],
  "Asia/Karachi": ["Pakistan", "PKT", "Lahore", "Islamabad"],
  "Asia/Dhaka": ["Bangladesh"],
  "Asia/Kathmandu": ["Nepal", "NPT", "Katmandu"],
  "Asia/Colombo": ["Sri Lanka"],
  "Asia/Thimphu": ["Bhutan"],
  "Indian/Maldives": ["Maldives", "Male"],
  "Asia/Singapore": ["Singapore", "SGT"],
  "Asia/Kuala_Lumpur": ["Malaysia", "MYT"],
  "Asia/Jakarta": ["Indonesia", "WIB"],
  "Asia/Bangkok": ["Thailand", "ICT"],
  "Asia/Ho_Chi_Minh": ["Vietnam", "Saigon"],
  "Asia/Manila": ["Philippines", "PHT"],
  "Asia/Hong_Kong": ["Hong Kong", "HKT"],
  "Asia/Shanghai": ["China", "Beijing"],
  "Asia/Tokyo": ["Japan", "JST"],
  "Asia/Seoul": ["South Korea", "Korea", "KST"],
  "Australia/Sydney": ["Australia", "AEST", "AEDT", "New South Wales"],
  "Australia/Melbourne": ["Australia", "Victoria"],
  "Australia/Perth": ["Australia", "AWST", "Western Australia"],
  "Pacific/Auckland": ["New Zealand", "NZST", "NZDT"],
  "Europe/London": ["United Kingdom", "UK", "Britain", "England", "GMT", "BST"],
  "Europe/Dublin": ["Ireland"],
  "Europe/Paris": ["France", "CET", "CEST"],
  "Europe/Berlin": ["Germany", "CET", "CEST"],
  "Europe/Amsterdam": ["Netherlands", "Holland"],
  "Europe/Madrid": ["Spain"],
  "Europe/Rome": ["Italy"],
  "Europe/Zurich": ["Switzerland"],
  "Europe/Moscow": ["Russia", "MSK"],
  "Europe/Istanbul": ["Turkey", "Türkiye"],
  "Africa/Cairo": ["Egypt"],
  "Africa/Johannesburg": ["South Africa", "SAST"],
  "Africa/Lagos": ["Nigeria", "WAT"],
  "Africa/Nairobi": ["Kenya", "EAT"],
  "America/New_York": ["United States", "USA", "US", "Eastern", "ET", "EST", "EDT"],
  "America/Chicago": ["United States", "USA", "US", "Central", "CT", "CDT"],
  "America/Denver": ["United States", "USA", "US", "Mountain", "MT", "MST", "MDT"],
  "America/Los_Angeles": ["United States", "USA", "US", "Pacific", "PT", "PST", "PDT", "California"],
  "America/Phoenix": ["United States", "Arizona"],
  "America/Anchorage": ["United States", "Alaska"],
  "Pacific/Honolulu": ["United States", "Hawaii", "HST"],
  "America/Toronto": ["Canada", "Eastern", "Ontario"],
  "America/Vancouver": ["Canada", "Pacific", "British Columbia"],
  "America/Sao_Paulo": ["Brazil", "BRT"],
  "America/Mexico_City": ["Mexico"],
  "America/Argentina/Buenos_Aires": ["Argentina"],
  UTC: ["Coordinated Universal Time", "GMT", "Zulu"],
};

export interface TimeZoneOption {
  id: string;
  city: string;
  region: string;
  offsetMinutes: number;
  offsetLabel: string;
  /** Lower-cased haystack words: id segments, city, region, keywords. */
  keywords: string[];
}

/**
 * Every zone this runtime knows, in current IANA spelling, deduplicated, with
 * the offset in force at `at`. Sorted by offset then city - the order a person
 * scanning for "somewhere two hours behind us" reads in.
 */
export function timeZoneOptions(at: Instant = Date.now(), ids?: readonly string[]): TimeZoneOption[] {
  const source =
    ids ?? (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [DEFAULT_TIME_ZONE]);
  const seen = new Set<string>();
  const out: TimeZoneOption[] = [];
  for (const raw of [...source, "UTC"]) {
    const id = canonicalTimeZone(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const offsetMinutes = utcOffsetMinutes(id, at);
    const city = timeZoneCity(id);
    const region = timeZoneRegion(id);
    const words = [id, ...id.split("/"), city, region, ...(KEYWORDS[id] ?? [])];
    out.push({
      id,
      city,
      region,
      offsetMinutes,
      offsetLabel: formatUtcOffset(offsetMinutes),
      keywords: [...new Set(words.map((w) => w.toLowerCase().replace(/_/g, " ")))],
    });
  }
  return out.sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city));
}

/**
 * "+5:30", "utc+4", "GMT-05", "+0530" as a UTC offset in minutes, else null.
 * Lets a person find a zone by the number on their phone's clock settings.
 */
export function parseOffsetQuery(query: string): number | null {
  const m = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(query.trim());
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = Number(m[3] ?? 0);
  if (hours > 14 || minutes >= 60) return null;
  return (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Filter and rank the catalogue for a query. An offset query matches by
 * offset; otherwise every word of the query must prefix some keyword.
 *
 * Ranking: an exact city > an exact keyword > a city prefix > a keyword
 * prefix. The middle order matters more than it looks - "ist" is a prefix of
 * Istanbul and an exact keyword of Kolkata, and on an Indian floor the person
 * typing IST means India.
 */
export function searchTimeZones(options: readonly TimeZoneOption[], query: string): TimeZoneOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  const offset = parseOffsetQuery(q);
  if (offset !== null) return options.filter((o) => o.offsetMinutes === offset);

  const tokens = q.split(/[\s,/]+/).filter(Boolean);
  const scored: Array<{ option: TimeZoneOption; score: number }> = [];
  for (const option of options) {
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const city = option.city.toLowerCase();
      if (city === q || option.id.toLowerCase() === q) score += 100;
      else if (city.startsWith(token)) score += 40;
      if (option.keywords.some((k) => k === token)) score += 60;
      else if (option.keywords.some((k) => k.split(" ").some((w) => w.startsWith(token)))) score += 10;
      else {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll) scored.push({ option, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.option.offsetMinutes - b.option.offsetMinutes)
    .map((s) => s.option);
}
