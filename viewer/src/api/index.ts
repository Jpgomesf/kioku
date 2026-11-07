// The frontend's whole backend contract. Each area folder owns its types, client
// calls and mock; import from "../api" (or one folder) rather than a mock directly.
export * from "./app";
export * from "./core";
export * from "./graph";
export * from "./health";
export * from "./notes";
export * from "./reflect";
export * from "./search";
export * from "./vaults";
