#!/usr/bin/env node
// This wrapper is the published bin. It is a different module from the
// internal CLI, so the internal "am I the entrypoint" guard can never match
// here; invoke the CLI explicitly instead of relying on import side effects.
import { runCliMain } from "../../pipeline-node/dist/cli.js";

void runCliMain();
