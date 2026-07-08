// src/model/source.js — classify an order's channel from the customer name.
//
// Per Naghedi: EDI applies to the wholesale retail-partner locations
// ShopBop, Nordstrom, and Bloomingdale's. Everything else in the warehouse
// searches is regular boutique wholesale. (DTC/Shopify orders flow a different
// path and generally aren't in these saved searches.)

const EDI_PATTERNS = [/shopbop/i, /nordstrom/i, /bloomingdale/i]

export function deriveSource(customer) {
  const c = customer || ''
  return EDI_PATTERNS.some((re) => re.test(c)) ? 'edi' : 'boutique'
}
