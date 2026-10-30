#!/usr/bin/env node
import { main } from "./cli-main";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`tuvl-client: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
