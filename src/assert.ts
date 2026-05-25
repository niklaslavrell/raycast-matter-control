// Compile-time exhaustiveness check. Pass the value at the end of a switch or
// if-chain over a discriminated union; TS will flag a missing case as a type
// error. Throws at runtime if reached (which shouldn't happen if the types
// agree with the values).
//
// Example:
//   switch (category) {
//     case "light": return …;
//     case "outlet": return …;
//     default: assertNever(category, "unknown category");
//   }
export function assertNever(value: never, message = "unhandled case"): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
