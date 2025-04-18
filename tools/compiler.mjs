#!/usr/bin/env node
/**
 * @license
 * Copyright 2010 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

// JavaScript compiler, main entry point

import assert from 'node:assert';
import {parseArgs} from 'node:util';
import {
  Benchmarker,
  applySettings,
  loadDefaultSettings,
  printErr,
  readFile,
} from '../src/utility.mjs';

loadDefaultSettings();

const options = {
  help: {type: 'boolean', short: 'h'},
  'symbols-only': {type: 'boolean'},
  output: {type: 'string', short: 'o'},
};
const {values, positionals} = parseArgs({options, allowPositionals: true});

if (values.help) {
  console.log(`\
Main entry point for JS compiler

If no -o file is specified then the generated code is written to stdout.

Usage: compiler.mjs <settings.json> [-o out.js] [--symbols-only]`);
  process.exit(0);
}

// Load settings from JSON passed on the command line
let settingsFile = positionals[0];
assert(settingsFile, 'settings file not specified');
if (settingsFile == '-') {
  // Read settings json from stdin (FD 0)
  settingsFile = 0;
}
const userSettings = JSON.parse(readFile(settingsFile));
applySettings(userSettings);

export const symbolsOnly = values['symbols-only'];

// TODO(sbc): Remove EMCC_BUILD_DIR at some point.  It used to be required
// back when ran the JS compiler with overridden CWD.
process.env['EMCC_BUILD_DIR'] = process.cwd();

// In case compiler.mjs is run directly (as in gen_sig_info)
// ALL_INCOMING_MODULE_JS_API might not be populated yet.
if (!ALL_INCOMING_MODULE_JS_API.length) {
  ALL_INCOMING_MODULE_JS_API = INCOMING_MODULE_JS_API;
}

EXPORTED_FUNCTIONS = new Set(EXPORTED_FUNCTIONS);
WASM_EXPORTS = new Set(WASM_EXPORTS);
SIDE_MODULE_EXPORTS = new Set(SIDE_MODULE_EXPORTS);
INCOMING_MODULE_JS_API = new Set(INCOMING_MODULE_JS_API);
ALL_INCOMING_MODULE_JS_API = new Set(ALL_INCOMING_MODULE_JS_API);
EXPORTED_RUNTIME_METHODS = new Set(EXPORTED_RUNTIME_METHODS);
WEAK_IMPORTS = new Set(WEAK_IMPORTS);
if (symbolsOnly) {
  INCLUDE_FULL_LIBRARY = 1;
}

// Side modules are pure wasm and have no JS
assert(
  !SIDE_MODULE || (ASYNCIFY && symbolsOnly),
  'JS compiler should only run on side modules if asyncify is used.',
);

// Load compiler code

// We can't use static import statements here because several of these
// file depend on having the settings defined in the global scope (which
// we do dynamically above.
await import('../src/modules.mjs');
await import('../src/parseTools.mjs');
if (!STRICT) {
  await import('../src/parseTools_legacy.mjs');
}
const jsifier = await import('../src/jsifier.mjs');

// ===============================
// Main
// ===============================

const B = new Benchmarker();

try {
  await jsifier.runJSify(values.output, symbolsOnly);

  B.print('glue');
} catch (err) {
  if (err.toString().includes('Aborting compilation due to previous errors')) {
    // Compiler failed on user error, don't print the stacktrace in this case.
    printErr(err);
  } else {
    // Compiler failed on internal compiler error!
    printErr('Internal compiler error JS compiler');
    printErr('Please create a bug report at https://github.com/emscripten-core/emscripten/issues/');
    printErr(
      'with a log of the build and the input files used to run. Exception message: "' +
        (err.stack || err),
    );
  }

  // Work around a node.js bug where stdout buffer is not flushed at process exit:
  // Instead of process.exit() directly, wait for stdout flush event.
  // See https://github.com/joyent/node/issues/1669 and https://github.com/emscripten-core/emscripten/issues/2582
  // Workaround is based on https://github.com/RReverser/acorn/commit/50ab143cecc9ed71a2d66f78b4aec3bb2e9844f6
  process.stdout.once('drain', () => process.exit(1));
  // Make sure to print something to force the drain event to occur, in case the
  // stdout buffer was empty.
  console.log(' ');
  // Work around another node bug where sometimes 'drain' is never fired - make
  // another effort to emit the exit status, after a significant delay (if node
  // hasn't fired drain by then, give up)
  setTimeout(() => process.exit(1), 500);
}
