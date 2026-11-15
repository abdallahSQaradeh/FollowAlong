// @ts-check
import { readFileSync } from 'node:fs';

/**
 * Parses JSON as `unknown`, so callers must narrow or cast it instead of using `any`.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJson(text) {
  return JSON.parse(text);
}

/**
 * @param {string} path
 * @returns {unknown}
 */
export function readJson(path) {
  return parseJson(readFileSync(path, 'utf8'));
}
