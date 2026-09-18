// The id every stored record gets: a timestamp in base 36 with a few random
// characters after it, so ids sort roughly by age and still don't collide
// within the same millisecond.
//
// One copy, imported by the server, the MCP server and the client alike — the
// client bundles this file, so keep it free of node built-ins.
function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export { newId };
