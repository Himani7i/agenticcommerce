// Merchant-level settings. In a real system these might live in a database
// row editable from a merchant dashboard; a constant is enough here to
// prove the guardrail actually works.
export const MAX_DISCOUNT_PCT = 15;

// Merchant-configured "goes well with" pairs. 
export const CROSS_SELL_MAP = {
  SHOES001: ['SOCKS001'],
  TSHIRT001: ['CAP001'],
  TSHIRT002: ['CAP001'],
  SOCKS001: ['SHOES001'],
  CAP001: ['TSHIRT001'],
  JACKET001: ['TSHIRT001'],
};