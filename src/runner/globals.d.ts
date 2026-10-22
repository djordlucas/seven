// The one global a run gets beyond Node's own (see child.ts). Declared here so
// tests and tools written in this repo typecheck.
declare var seven: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
