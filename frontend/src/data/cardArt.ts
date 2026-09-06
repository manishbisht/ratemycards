const ART_ROOT = '/card-art'

const BANK_ART: Record<string, string> = {
  HDFC: 'hdfc',
  ICICI: 'icici',
  Axis: 'axis',
  'American Express': 'american-express',
  Kotak: 'kotak',
  SBI: 'sbi',
  IndusInd: 'indusind',
  'IDFC FIRST': 'idfc-first',
  HSBC: 'hsbc',
  AU: 'au',
  RBL: 'rbl',
  'Bank of Baroda': 'bank-of-baroda',
}

/**
 * Which way a tile is painted. The palette is split on purpose -- an issuer
 * whose logo is a bright mark gets a dark tile, and one whose mark is dark gets
 * a pale tile -- so anything drawn on top of the art has to know which it is
 * landing on. Generic art is dark, so an unknown issuer is too.
 */
const LIGHT_TILE = new Set(['Axis', 'Kotak', 'RBL', 'IndusInd', 'IDFC FIRST'])

export function cardArtTone(issuer: string): 'light' | 'dark' {
  return LIGHT_TILE.has(issuer) ? 'light' : 'dark'
}

/** Resolves the issuer's tile, falling back to generic art for a new issuer. */
export function cardArtSrc(issuer: string): string {
  return `${ART_ROOT}/banks/${BANK_ART[issuer] ?? 'generic'}.svg`
}
