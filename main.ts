// token-radar-01 entry (Node 22, standard library only).
//
// What it does, end to end: read the sealed DefiLlama snapshot, score every pre-token
// protocol with the radar-2 model in lib/model.ts, and write the submission directory:
//
//   board.json     the ranked board (watchlist + every rankable protocol below the floor)
//   data.js        the same board, compact, for the dashboard to read with no network
//   dashboard/     the static page: index.html + app.css + app.js
//   screenshots/   three views of that page: the board, a detail view, a filtered view
//   dossier.json   the judge's summary, built last by the vendored make.fun library
//
// The run is deterministic: same snapshot in, same bytes out, twice in a row. No clock,
// no random, no network. In the grader's container the snapshot lives at /input and the
// output at /output; locally, MAKEFUN_OUTPUT_DIR stands in for /output:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// The scorer's caps: only the text cap shapes bytes; the rest refuse outright.
const TEXT_CAP_BYTES = 65_536;
const SHOT_CAP = { max: 4, max_bytes: 524_288 };
const DASH_CAP = { max_files: 400, max_bytes: 4_194_304 };
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read a `--name value` or `--name=value` argument, or fall back. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1]!;
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

function fail(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

/** Copy a directory's regular files into `to`, skipping dot-names; returns what was copied. */
function copyDir(from: string, to: string): string[] {
  if (!fs.existsSync(from)) return [];
  fs.mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of fs.readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = path.join(from, name);
    if (!fs.statSync(source).isFile()) continue;
    fs.copyFileSync(source, path.join(to, name));
    copied.push(name);
  }
  return copied;
}

function main(): void {
  const inputArg = flag('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : path.join(inputArg, 'snapshot.json');
  if (!fs.existsSync(inputFile)) {
    fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
  }
  const out = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(fs.readFileSync(inputFile, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`, 1);

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  fs.writeFileSync(path.join(out, 'data.js'), dataScript(radar));

  copyDir(path.join(repoRoot, 'dashboard'), path.join(out, 'dashboard'));
  const shots = copyDir(path.join(repoRoot, 'screenshots'), path.join(out, 'screenshots'));
  if (shots.length < 3) {
    fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`, 1);
  }
  for (const name of shots) {
    if (!PLAIN_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
  }

  // The dossier goes last: the scorer rebuilds it from this directory and compares bytes.
  fs.writeFileSync(
    path.join(out, 'dossier.json'),
    buildDossier(out, { text_max_bytes: TEXT_CAP_BYTES, screenshots: SHOT_CAP, dashboard: DASH_CAP }),
  );

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ` +
      `${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: wrote ${path.join(out, 'board.json')}, ${path.join(out, 'data.js')}, ` +
      `${path.join(out, 'dashboard')} (3 files), ${path.join(out, 'screenshots')} (${shots.length} images) ` +
      `and ${path.join(out, 'dossier.json')}\n`,
  );
}

main();
