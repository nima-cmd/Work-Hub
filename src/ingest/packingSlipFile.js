// src/ingest/packingSlipFile.js — bytes of a packing slip → rows the model can read.
//
// ⚠️ THE ONLY REASON THIS FILE EXISTS IS TO KEEP `xlsx` OUT OF THE MODEL.
// src/model/packingSlip.js is pure — rows in, container out — so it can be tested
// against the real slips in test/fixtures without a spreadsheet library or a
// browser. The original in Naghedi-Warehouse read the workbook inside its own
// `rowsFromData`, which is why it could not be unit-tested and why the carton
// double-count survived unnoticed on every container. See that module's header.

import * as XLSX from 'xlsx'
import { parsePackingSlip } from '../model/packingSlip.js'
import { parseCsvRows } from './csv.js'

/**
 * Bytes → 2-D rows.
 *
 * ⚠️ `raw: false` MATTERS. It hands back formatted strings, so a carton range
 * typed as "3-6" survives instead of being coerced, and a date-formatted cell
 * reads as it appears on the page rather than as a serial number. The model's
 * numeric guards (`/^[\d.]+$/` on style, `Number(...)` on quantities) are written
 * for strings.
 *
 * ⚠️ `defval: ''` keeps merged/blank cells as empty strings rather than dropping
 * them, so column positions stay aligned — the model reads columns by INDEX, and a
 * collapsed row would silently shift style into colour.
 */
export function rowsFromXlsx(bytes) {
  const wb = XLSX.read(bytes, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
}

/**
 * CSV text → 2-D rows, via this repo's own dependency-free parser.
 *
 * ⚠️ `parseCsvRows`, NOT `parseCsv`. The latter returns objects keyed by header and
 * drops the header row — right for a saved-search export, wrong for a document read
 * by COLUMN POSITION. A factory slip has a two-row bilingual header and merged
 * cells; its meaning is in the grid, not in header names.
 */
export function rowsFromCsvText(text) {
  return parseCsvRows(String(text ?? ''))
}

/**
 * Read a slip from bytes or text and parse it.
 *
 * @param input  Uint8Array/ArrayBuffer for .xlsx, or a string for .csv
 */
export function readPackingSlip(input, opts = {}) {
  const rows = typeof input === 'string' ? rowsFromCsvText(input) : rowsFromXlsx(input)
  return parsePackingSlip(rows, opts)
}
