import path from "node:path";
export default async function* reporter(events) {
  for await (const event of events) {
    const d = event.data;
    if (
      !["test:pass", "test:fail", "test:summary", "test:diagnostic"].includes(
        event.type,
      )
    )
      continue;
    yield JSON.stringify({
      type: event.type,
      name: d.name,
      file: d.file ? path.basename(d.file) : null,
      nesting: d.nesting,
      skip: d.skip || false,
      todo: d.todo || false,
      durationMs: d.details?.duration_ms,
      ...(event.type === "test:diagnostic" ? { message: d.message } : {}),
      error: d.details?.error
        ? {
            message: d.details.error.message,
            stack: d.details.error.stack,
            cause: d.details.error.cause?.message,
          }
        : undefined,
      ...(event.type === "test:summary" ? { counts: d.counts } : {}),
      at: new Date().toISOString(),
    }) + "\n";
  }
}
