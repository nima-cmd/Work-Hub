// src/ingest/csv.js
// A minimal, dependency-free CSV parser (RFC-4180-ish).
//
// Why hand-write it? NetSuite exports occasionally quote fields that contain
// commas, and one of your saved searches has a DUPLICATE column name
// ("Shipping Status" twice). This parser handles both, and keeps us free of
// an npm dependency for something this small.
//
// parseCsv(text) -> array of row objects keyed by (de-duplicated) header name.

export function parseCsv(text) {
  const rows = parseRows(text)
  if (rows.length === 0) return []

  const headers = dedupeHeaders(rows[0])
  return rows
    .slice(1)
    .filter((cells) => cells.some((c) => c.trim() !== '')) // drop blank lines
    .map((cells) => {
      const obj = {}
      headers.forEach((h, i) => {
        obj[h] = (cells[i] ?? '').trim()
      })
      return obj
    })
}

// Split the raw text into rows of raw cell strings, honoring quotes.
function parseRows(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"' // an escaped quote ("")
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\r') {
      // ignore — handled by \n
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }

  // flush the final field/row when there's no trailing newline
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// "Shipping Status" appearing twice becomes "Shipping Status" and
// "Shipping Status (2)" so one column can't silently clobber the other.
function dedupeHeaders(headers) {
  const seen = {}
  return headers.map((h) => {
    const name = h.trim()
    if (seen[name] == null) {
      seen[name] = 1
      return name
    }
    seen[name] += 1
    return `${name} (${seen[name]})`
  })
}
