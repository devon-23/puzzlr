/**
 * Runs Game#bestChain off the main thread.
 *
 * The server is otherwise single-threaded and synchronous (better-sqlite3 has
 * no async API), so a search that runs for several seconds would stall every
 * other player's request for as long as it took. A worker thread can't share
 * the main thread's database handle, so it opens its own read-only one on the
 * same catalog file — cheap, since catalog.db never changes underneath it.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { Game } from './game.js';

const { catalogPath, startSongId, startWord, opts } = workerData;
const db = new Database(catalogPath, { readonly: true });
const game = new Game(db);

try {
  parentPort.postMessage(game.bestChain(startSongId, startWord, opts));
} finally {
  db.close();
}
