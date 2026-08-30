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

const CARD_ART: Record<string, string> = {
  'HDFC|Infinia Metal': 'hdfc-infinia-metal',
  'ICICI|Emeralde Private Metal': 'icici-emeralde-private-metal',
  'Axis|Primus': 'axis-primus',
  'American Express|Centurion Charge Card': 'american-express-centurion-charge-card',
  'Kotak|White Reserve': 'kotak-white-reserve',
  'SBI|AURUM': 'sbi-aurum',
  'IndusInd|Pioneer Heritage': 'indusind-pioneer-heritage',
  'IDFC FIRST|Mayura': 'idfc-first-mayura',
  'HSBC|Privé': 'hsbc-prive',
  'AU|Zenith': 'au-zenith',
  'RBL|World Safari': 'rbl-world-safari',
  'Bank of Baroda|Etihad Guest Premium': 'bank-of-baroda-etihad-guest-premium',
}

/** Resolves dedicated art first, then its local issuer card, then generic art. */
export function cardArtSrc(issuer: string, name: string): string {
  const card = CARD_ART[`${issuer}|${name}`]
  if (card) return `${ART_ROOT}/cards/${card}.svg`

  const bank = BANK_ART[issuer]
  return `${ART_ROOT}/banks/${bank ?? 'generic'}.svg`
}
