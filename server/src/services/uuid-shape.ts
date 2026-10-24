/**
 * Postgres accepts a uuid in three spellings: dashed, undashed hex, and
 * braced. A value that is none of those can never match a uuid column, so
 * it is refused before the database sees it instead of failing the query
 * with an invalid input syntax error.
 */
const UUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_UNDASHED = /^[0-9a-f]{32}$/i;
const UUID_BRACED = /^\{(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\}$/i;

/** True when the value is a uuid in a spelling the database accepts. */
export function isUuidShaped(value: string): boolean {
  return UUID_DASHED.test(value) || UUID_UNDASHED.test(value) || UUID_BRACED.test(value);
}
