/** Tiny line logger: `HH:MM:SS LEVEL message k=v k=v`. `DEBUG=1` enables debug lines. */
const DEBUG = ["1", "true", "yes"].includes((process.env.DEBUG ?? "").toLowerCase());

type Fields = Record<string, unknown>;

const stamp = () => new Date().toISOString().slice(11, 19);

function fmt(fields?: Fields): string {
  if (!fields) return "";
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : String(v)}`);
  return parts.length ? " " + parts.join(" ") : "";
}

function line(level: string, msg: string, fields?: Fields) {
  const out = `${stamp()} ${level.padEnd(5)} ${msg}${fmt(fields)}`;
  if (level === "ERROR" || level === "WARN") console.error(out);
  else console.log(out);
}

export const log = {
  info: (msg: string, fields?: Fields) => line("INFO", msg, fields),
  warn: (msg: string, fields?: Fields) => line("WARN", msg, fields),
  error: (msg: string, fields?: Fields) => line("ERROR", msg, fields),
  debug: (msg: string, fields?: Fields) => {
    if (DEBUG) line("DEBUG", msg, fields);
  },
};
