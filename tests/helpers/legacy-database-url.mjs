// Historical-table regressions explicitly select their subject now that the
// product landing page is the current season. Separate tests cover the default.
export function legacyDatabaseUrl(input){const u=new URL(input);if(!u.searchParams.has('mode'))u.searchParams.set('mode','database');return u.href;}
