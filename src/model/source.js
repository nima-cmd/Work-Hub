// src/model/source.js — classify an order's channel from the customer name.
//
// Per Naghedi: EDI applies to the wholesale retail-partner locations
// ShopBop, Nordstrom, and Bloomingdale's. Everything else in the warehouse
// searches is regular boutique wholesale. (DTC/Shopify orders flow a different
// path and generally aren't in these saved searches.)

const EDI_PATTERNS = [/shopbop/i, /nordstrom/i, /bloomingdale/i]

// Location (e.g. "Warehouse Bulk : Nordstrom") is the authoritative NetSuite
// signal when present; customer name is the fallback for sources that don't
// carry a location column (e.g. the Item Fulfillment / Invoice searches).
export function deriveSource(customer, location) {
  const l = location || ''
  const c = customer || ''
  return EDI_PATTERNS.some((re) => re.test(l) || re.test(c)) ? 'edi' : 'boutique'
}
