// src/model/channels.js — classify an order into a CHANNEL and give it a
// consistent label + color, so the same account always reads the same way
// across every view (Nima, 2026-07-20: "all boutiques use one color, Nordstrom
// another, Bloomingdale's another…"). Location is the authoritative NetSuite
// signal (see [[naghedi-locations]]); customer name is the fallback for sources
// that carry no location column (IF/Invoice searches).
//
// This is a superset of src/model/source.js's edi/boutique split — same idea,
// finer buckets, plus presentation. source.js stays the thing the pipeline
// keys off; this is purely for display.

export const CHANNEL_META = {
  nordstrom:      { label: 'Nordstrom',       color: '#5b8def' }, // blue
  bloomingdales:  { label: "Bloomingdale's",  color: '#b678ff' }, // violet
  shopbop:        { label: 'Shopbop',         color: '#ff6fae' }, // pink
  boutique:       { label: 'Boutique',        color: '#34d399' }, // green
  ecom:           { label: 'E-com',           color: '#2dd4bf' }, // teal
  holt:           { label: 'Holt Renfrew',    color: '#f59e0b' }, // amber
  'saint-bernard':{ label: 'Saint Bernard',   color: '#e8a33d' }, // gold
  china:          { label: 'China / FOB',     color: '#9aa5b1' }, // grey
}

// Order/consignee → channel key. Checks the most specific accounts first, then
// falls back to the generic location buckets, then boutique.
export function channelKey({ location, customer } = {}) {
  const s = `${location || ''} ${customer || ''}`
  if (/nordstrom/i.test(s)) return 'nordstrom'
  if (/bloomingdale/i.test(s)) return 'bloomingdales'
  if (/shopbop/i.test(s)) return 'shopbop'
  if (/holt\s*renfrew/i.test(s)) return 'holt'
  if (/saint\s*bernard/i.test(s)) return 'saint-bernard'
  const loc = location || ''
  if (/china/i.test(loc)) return 'china'
  if (/virtual\s*warehouse/i.test(loc)) return 'ecom'
  // everything else in the warehouse searches is regular boutique wholesale
  return 'boutique'
}

export function channelMeta(order) {
  return CHANNEL_META[channelKey(order)] || CHANNEL_META.boutique
}
