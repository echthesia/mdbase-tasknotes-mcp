import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("rrule") as typeof import("rrule");

export const RRule = pkg.RRule;
export default pkg;
