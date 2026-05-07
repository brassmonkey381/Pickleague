/**
 * Comprehensive pickleball paddle models seed.
 * Safe to re-run — uses upsert/on-conflict.
 * Add new models here as brands release them.
 */
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Each entry: { brand, models: [ { name, thickness_mm?, notes?, sort_order? } ] }
const CATALOG = [
  {
    brand: 'JOOLA',
    models: [
      { name: 'Ben Johns Hyperion CFS 16',     thickness_mm: 16, notes: 'Carbon friction surface', sort_order: 1 },
      { name: 'Ben Johns Hyperion CFS 14',     thickness_mm: 14, sort_order: 2 },
      { name: 'Perseus CFS 16',                thickness_mm: 16, sort_order: 3 },
      { name: 'Perseus CFS 14',                thickness_mm: 14, sort_order: 4 },
      { name: 'Perseus Pro V 16',              thickness_mm: 16, sort_order: 5 },
      { name: 'Perseus Pro V 14',              thickness_mm: 14, sort_order: 6 },
      { name: 'Solaire CFS 16',                thickness_mm: 16, notes: 'Elongated', sort_order: 7 },
      { name: 'Vision CGS 16',                 thickness_mm: 16, sort_order: 8 },
      { name: 'Vision CGS 14',                 thickness_mm: 14, sort_order: 9 },
      { name: 'AGS 16',                        thickness_mm: 16, sort_order: 10 },
      { name: 'Collin Johns Scorpeus CFS 16',  thickness_mm: 16, sort_order: 11 },
      { name: 'Essentials',                    notes: 'Entry-level', sort_order: 20 },
    ],
  },
  {
    brand: 'Selkirk',
    models: [
      { name: 'LABS Project BOOMSTICK',              thickness_mm: 16, notes: 'Elongated, thermoformed, hot in 2025-26', sort_order: 1 },
      { name: 'LABS Project 003',                    notes: 'Thermoformed', sort_order: 2 },
      { name: 'Vanguard Power Air Invikta',          thickness_mm: 16, notes: 'Elongated', sort_order: 3 },
      { name: 'Vanguard Power Air Epic',             thickness_mm: 16, sort_order: 4 },
      { name: 'Vanguard Power Air S2',               thickness_mm: 16, sort_order: 5 },
      { name: 'Vanguard Hybrid Control Invikta',     thickness_mm: 16, sort_order: 6 },
      { name: 'Vanguard Hybrid Control Epic',        thickness_mm: 16, sort_order: 7 },
      { name: 'Vanguard Pro Hybrid Invikta',         sort_order: 8 },
      { name: 'LUXX Control Air Invikta',            thickness_mm: 16, sort_order: 9 },
      { name: 'LUXX Control Air Epic',               thickness_mm: 16, sort_order: 10 },
      { name: 'SLK HALO Power XL',                  notes: 'Carbon', sort_order: 11 },
      { name: 'SLK HALO Control XL',                notes: 'Carbon', sort_order: 12 },
      { name: 'SLK HALO Pro XL',                    sort_order: 13 },
      { name: 'SLK Omega Max',                       sort_order: 14 },
      { name: 'SLK Evo Control Max',                 sort_order: 15 },
      { name: 'SLK Evo Power Max',                   sort_order: 16 },
      { name: 'SLK Latitude Widebody',               sort_order: 17 },
      { name: 'Amped Invikta',                       sort_order: 18 },
      { name: 'Amped Epic',                          sort_order: 19 },
      { name: 'Amped S2',                            sort_order: 20 },
    ],
  },
  {
    brand: 'CRBN',
    models: [
      { name: 'TruFoam',                       notes: 'Original TruFoam model', sort_order: 1 },
      { name: 'TruFoam Genesis 1',             notes: '16mm true foam core', sort_order: 2 },
      { name: 'TruFoam Genesis 2',             notes: 'Elongated, 16mm true foam', sort_order: 3 },
      { name: 'TruFoam Genesis 3',             notes: 'Widebody, 16mm true foam', sort_order: 4 },
      { name: 'TruFoam Genesis 4',             notes: 'Hybrid shape, 16mm true foam', sort_order: 5 },
      { name: 'CRBN 1X Power Series 16',       thickness_mm: 16, sort_order: 6 },
      { name: 'CRBN 1X Power Series 14',       thickness_mm: 14, sort_order: 7 },
      { name: 'CRBN 2X Power Series 16',       thickness_mm: 16, sort_order: 8 },
      { name: 'CRBN 2X Power Series 14',       thickness_mm: 14, sort_order: 9 },
      { name: 'CRBN 3X Power Series 16',       thickness_mm: 16, sort_order: 10 },
      { name: 'CRBN 3X Power Series 14',       thickness_mm: 14, sort_order: 11 },
    ],
  },
  {
    brand: 'Ripple',
    models: [
      { name: 'Quanta V1',     notes: 'Classic Ripple model', sort_order: 1 },
      { name: 'Quanta V2',     sort_order: 2 },
    ],
  },
  {
    brand: 'Ronbus / Ripple',
    models: [
      { name: 'Quanta V1',              notes: 'Original Quanta', sort_order: 1 },
      { name: 'Quanta V2',              sort_order: 2 },
      { name: 'R1.16 Aero-Curve',       thickness_mm: 16, notes: 'Elongated', sort_order: 3 },
      { name: 'R2.16 Widebody',         thickness_mm: 16, sort_order: 4 },
      { name: 'R3.16 Square-Head',      thickness_mm: 16, notes: 'Elongated', sort_order: 5 },
      { name: 'R4.16 Hybrid',           thickness_mm: 16, sort_order: 6 },
      { name: 'R5.16 Widebody Long',    thickness_mm: 16, sort_order: 7 },
    ],
  },
  {
    brand: 'Engage',
    models: [
      { name: 'Pursuit Pro MX 6.0',     thickness_mm: 16, sort_order: 1 },
      { name: 'Pursuit Pro EX 6.0',     thickness_mm: 16, sort_order: 2 },
      { name: 'Pursuit MX 6.0',         thickness_mm: 16, sort_order: 3 },
      { name: 'Pursuit EX 6.0',         thickness_mm: 16, sort_order: 4 },
      { name: 'Encore Pro V2.0',        sort_order: 5 },
      { name: 'Encore MX 6.0',          sort_order: 6 },
      { name: 'Alpha Pro',              sort_order: 7 },
      { name: 'ProFoam EX',             notes: 'Foam core', sort_order: 8 },
      { name: 'Poach Infinity EX',      sort_order: 9 },
    ],
  },
  {
    brand: 'Paddletek',
    models: [
      { name: 'Tempest Wave Pro',        sort_order: 1 },
      { name: 'Tempest Wave II',         sort_order: 2 },
      { name: 'Phoenix Genesis',         sort_order: 3 },
      { name: 'Phoenix G6',              sort_order: 4 },
      { name: 'Bantam EX-L Pro',         sort_order: 5 },
      { name: 'Bantam TS-5 Pro',         sort_order: 6 },
      { name: 'Sabre Pro',               sort_order: 7 },
    ],
  },
  {
    brand: 'Six Zero',
    models: [
      { name: 'Double Black Diamond Control 16', thickness_mm: 16, sort_order: 1 },
      { name: 'Double Black Diamond Control 14', thickness_mm: 14, sort_order: 2 },
      { name: 'Double Black Diamond Power 16',   thickness_mm: 16, sort_order: 3 },
      { name: 'Coral 16 Hybrid',                 thickness_mm: 16, sort_order: 4 },
      { name: 'Coral 14',                        thickness_mm: 14, sort_order: 5 },
      { name: 'Coral Lightweight',               sort_order: 6 },
      { name: 'Infinity Edgeless 16',            thickness_mm: 16, sort_order: 7 },
    ],
  },
  {
    brand: 'Diadem',
    models: [
      { name: 'Warrior Edge',           sort_order: 1 },
      { name: 'Warrior BluCore V3 Pro', sort_order: 2 },
      { name: 'Warrior BluCore',        sort_order: 3 },
      { name: 'Icon V2',                sort_order: 4 },
      { name: 'Icon Infinity',          sort_order: 5 },
      { name: 'Edge 18K Power Pro',     sort_order: 6 },
      { name: 'Edge 18K Speed Pro',     sort_order: 7 },
      { name: 'Hush',                   sort_order: 8 },
      { name: 'Riptide',                sort_order: 9 },
      { name: 'Hero',                   sort_order: 10 },
    ],
  },
  {
    brand: 'Electrum',
    models: [
      { name: 'Model E Pro 16',         thickness_mm: 16, sort_order: 1 },
      { name: 'Model E Pro 13',         thickness_mm: 13, sort_order: 2 },
      { name: 'Model E 16',             thickness_mm: 16, sort_order: 3 },
      { name: 'Model E 13',             thickness_mm: 13, sort_order: 4 },
      { name: 'Model E Stealth',        sort_order: 5 },
    ],
  },
  {
    brand: 'Gearbox',
    models: [
      { name: 'Pro Ultimate Elongated 16', thickness_mm: 16, sort_order: 1 },
      { name: 'Pro Control Elongated 16',  thickness_mm: 16, sort_order: 2 },
      { name: 'Pro Power Fusion 16',       thickness_mm: 16, sort_order: 3 },
      { name: 'CX14E Power',               sort_order: 4 },
      { name: 'CX14E Control',             sort_order: 5 },
      { name: 'GX6 Power',                 sort_order: 6 },
      { name: 'GX5 Control',               sort_order: 7 },
      { name: 'G2 Elongated',              sort_order: 8 },
      { name: 'CP7 Control',               sort_order: 9 },
    ],
  },
  {
    brand: 'Vatic Pro',
    models: [
      { name: 'Flash 16',               thickness_mm: 16, sort_order: 1 },
      { name: 'Flash 14',               thickness_mm: 14, sort_order: 2 },
      { name: 'V7 16',                  thickness_mm: 16, sort_order: 3 },
      { name: 'V7 14',                  thickness_mm: 14, sort_order: 4 },
      { name: 'PRISM 16',               thickness_mm: 16, sort_order: 5 },
      { name: 'PRISM 14',               thickness_mm: 14, sort_order: 6 },
      { name: 'V-SOL Pro 16',           thickness_mm: 16, sort_order: 7 },
      { name: 'V-SOL Pro 14',           thickness_mm: 14, sort_order: 8 },
    ],
  },
  {
    brand: 'Onix',
    models: [
      { name: 'Evoke Premier Raw Carbon',  sort_order: 1 },
      { name: 'Evoke Premier',             sort_order: 2 },
      { name: 'Hype X Pro',                sort_order: 3 },
      { name: 'Hype X',                    sort_order: 4 },
      { name: 'Malice DB',                 notes: 'Dual balance', sort_order: 5 },
      { name: 'Malice',                    sort_order: 6 },
      { name: 'Graphite Z5',               sort_order: 7 },
      { name: 'Composite Z5',              sort_order: 8 },
      { name: 'Stryker 4 Composite',       sort_order: 9 },
      { name: 'Tremor',                    sort_order: 10 },
    ],
  },
  {
    brand: 'Head',
    models: [
      { name: 'Gravity Tour',              sort_order: 1 },
      { name: 'Gravity Tour Lite',         sort_order: 2 },
      { name: 'Gravity (Short Handle)',     sort_order: 3 },
      { name: 'Extreme Tour Max',          sort_order: 4 },
      { name: 'Extreme Tour',              sort_order: 5 },
      { name: 'Extreme Elite',             sort_order: 6 },
      { name: 'Radical Pro',               sort_order: 7 },
      { name: 'Radical Elite',             sort_order: 8 },
      { name: 'Radical XL',                sort_order: 9 },
    ],
  },
  {
    brand: 'Franklin',
    models: [
      { name: 'Ben Johns Signature 14mm',  thickness_mm: 14, sort_order: 1 },
      { name: 'Ben Johns Signature 13mm',  thickness_mm: 13, sort_order: 2 },
      { name: 'C45 Dynasty 16',            thickness_mm: 16, sort_order: 3 },
      { name: 'C45 Dynasty 14',            thickness_mm: 14, sort_order: 4 },
      { name: 'C45 Tempo',                 sort_order: 5 },
      { name: 'Signature Pickleball Pro',  sort_order: 6 },
    ],
  },
  {
    brand: 'Gamma',
    models: [
      { name: 'NeuCore Needle 14',         thickness_mm: 14, sort_order: 1 },
      { name: 'Airbender 16',              thickness_mm: 16, sort_order: 2 },
      { name: 'Airbender 13',              thickness_mm: 13, sort_order: 3 },
      { name: 'Knockout 16',               thickness_mm: 16, sort_order: 4 },
      { name: 'RZR',                       sort_order: 5 },
      { name: 'Compass 206',               sort_order: 6 },
      { name: 'Neutron 2.0',               sort_order: 7 },
      { name: 'Hellbender',                sort_order: 8 },
      { name: 'Rainmaker',                 sort_order: 9 },
      { name: 'Obsidian 13',               thickness_mm: 13, sort_order: 10 },
    ],
  },
  {
    brand: 'ProKennex',
    models: [
      { name: 'Black Ace 14',              thickness_mm: 14, sort_order: 1 },
      { name: 'Black Ace 16',              thickness_mm: 16, sort_order: 2 },
      { name: 'Black Ace XF 14',           thickness_mm: 14, sort_order: 3 },
      { name: 'Black Ace LG 14',           thickness_mm: 14, notes: 'Long handle', sort_order: 4 },
      { name: 'Overton Flight',            sort_order: 5 },
      { name: 'Pro Speed',                 sort_order: 6 },
    ],
  },
  {
    brand: 'ProLite',
    models: [
      { name: 'Titan Pro BDS',             sort_order: 1 },
      { name: 'Titan Pro LX',              sort_order: 2 },
      { name: 'Stealth GS-1',              sort_order: 3 },
      { name: 'Stealth GS-2',              sort_order: 4 },
      { name: 'Rebel PowerSpin 2.0',       sort_order: 5 },
      { name: 'Rival PowerSpin 2.0',       sort_order: 6 },
      { name: 'Crush PowerSpin',           sort_order: 7 },
      { name: 'Supernova Pro',             sort_order: 8 },
      { name: 'Bolt',                      sort_order: 9 },
    ],
  },
  {
    brand: 'Babolat',
    models: [
      { name: 'STRKR+',                    sort_order: 1 },
      { name: 'MNSTR+',                    sort_order: 2 },
      { name: 'RBEL Touch 13',             thickness_mm: 13, sort_order: 3 },
      { name: 'RBEL Air Viper',            sort_order: 4 },
      { name: 'WZRD',                      sort_order: 5 },
      { name: 'BALL+',                     sort_order: 6 },
      { name: 'RNGD',                      sort_order: 7 },
      { name: 'XPLR',                      sort_order: 8 },
    ],
  },
  {
    brand: 'Vulcan',
    models: [
      { name: 'V560 Power',                sort_order: 1 },
      { name: 'V550 Elongated',            notes: 'Elongated', sort_order: 2 },
      { name: 'V540 Hybrid',               sort_order: 3 },
      { name: 'V520 Control',              sort_order: 4 },
      { name: 'V510',                      sort_order: 5 },
      { name: 'V930 Carbon',               notes: 'Elite series', sort_order: 6 },
      { name: 'V720 Made in USA',          sort_order: 7 },
    ],
  },
  {
    brand: 'Bread & Butter',
    models: [
      { name: 'Filth',                     notes: '100% foam core, elongated', sort_order: 1 },
      { name: 'Loco',                      notes: '100% foam core', sort_order: 2 },
      { name: 'Wild Thang',                sort_order: 3 },
      { name: 'Invader',                   sort_order: 4 },
      { name: 'Shogun',                    sort_order: 5 },
      { name: 'Fatboy',                    sort_order: 6 },
      { name: 'Spear',                     sort_order: 7 },
      { name: 'Drip',                      sort_order: 8 },
    ],
  },
  {
    brand: 'Gruvn',
    models: [
      { name: 'RAW-16E',                   thickness_mm: 16, notes: 'Elongated', sort_order: 1 },
      { name: 'RAW-16H',                   thickness_mm: 16, notes: 'Hybrid', sort_order: 2 },
      { name: 'RAW-16S',                   thickness_mm: 16, notes: 'Standard', sort_order: 3 },
      { name: 'RAW-14E',                   thickness_mm: 14, sort_order: 4 },
      { name: 'MÜVN-16',                   thickness_mm: 16, sort_order: 5 },
      { name: 'CRÜZN-16',                  thickness_mm: 16, sort_order: 6 },
      { name: 'LAZR',                      sort_order: 7 },
    ],
  },
  {
    brand: 'Wilson',
    models: [
      { name: 'Blaze 13 Carbon Fiber',     thickness_mm: 13, sort_order: 1 },
      { name: 'Blaze Pro 13',              thickness_mm: 13, sort_order: 2 },
      { name: 'Vesper Power Carbon',       sort_order: 3 },
      { name: 'Juice',                     sort_order: 4 },
      { name: 'Echo',                      sort_order: 5 },
      { name: 'Energy Pro',                sort_order: 6 },
    ],
  },
  {
    brand: 'Adidas',
    models: [
      { name: 'ADIPOWER ATTK',             sort_order: 1 },
      { name: 'ADIPOWER CTRL',             sort_order: 2 },
      { name: 'RX Team ATTK Elongated',    notes: 'Elongated', sort_order: 3 },
      { name: 'RX Team CTRL Square',       sort_order: 4 },
      { name: 'RX Carbon',                 sort_order: 5 },
      { name: 'Match',                     sort_order: 6 },
    ],
  },
  {
    brand: 'Volair',
    models: [
      { name: 'Mach 1 Forza',             sort_order: 1 },
      { name: 'Mach 2 Forza 14',          thickness_mm: 14, sort_order: 2 },
      { name: 'Mach 2 Forza 16',          thickness_mm: 16, sort_order: 3 },
      { name: 'Pro 2 16',                  thickness_mm: 16, sort_order: 4 },
      { name: 'Pro 2 14',                  thickness_mm: 14, sort_order: 5 },
    ],
  },
  {
    brand: '11SIX24',
    models: [
      { name: 'Power 2 Gen 4 Huarache-X',  notes: 'Elongated', sort_order: 1 },
      { name: 'Power 2 Gen 4 Vapor',        notes: 'Hybrid', sort_order: 2 },
      { name: 'Power 2 Gen 4 Pegasus',      notes: 'Widebody', sort_order: 3 },
      { name: 'Power Gen 3',                sort_order: 4 },
      { name: 'All Court',                  sort_order: 5 },
      { name: 'Jelly Bean',                 sort_order: 6 },
    ],
  },
  {
    brand: 'Six Zero',
    models: [
      { name: 'Double Black Diamond Control 16', thickness_mm: 16, sort_order: 1 },
      { name: 'Double Black Diamond Control 14', thickness_mm: 14, sort_order: 2 },
      { name: 'Double Black Diamond Power 16',   thickness_mm: 16, sort_order: 3 },
      { name: 'Coral 16',                        thickness_mm: 16, sort_order: 4 },
      { name: 'Coral Lightweight',               sort_order: 5 },
      { name: 'Infinity Edgeless 16',            thickness_mm: 16, sort_order: 6 },
    ],
  },
  {
    brand: 'Holbrook',
    models: [
      { name: 'Aero 16',               thickness_mm: 16, notes: 'Edgeless', sort_order: 1 },
      { name: 'ARMA',                   notes: 'Dual-density core', sort_order: 2 },
      { name: 'Power Pro',              sort_order: 3 },
    ],
  },
  {
    brand: 'Legacy',
    models: [
      { name: 'Legacy Pro',             sort_order: 1 },
      { name: 'Legacy Pro S',           sort_order: 2 },
      { name: 'Legacy Pro Air',         sort_order: 3 },
    ],
  },
  {
    brand: 'Vatic Pro',
    models: [
      { name: 'Flash 16',               thickness_mm: 16, sort_order: 1 },
      { name: 'Flash 14',               thickness_mm: 14, sort_order: 2 },
      { name: 'V7 16',                  thickness_mm: 16, sort_order: 3 },
      { name: 'V7 14',                  thickness_mm: 14, sort_order: 4 },
      { name: 'PRISM 16',               thickness_mm: 16, sort_order: 5 },
      { name: 'V-SOL Pro 16',           thickness_mm: 16, sort_order: 6 },
    ],
  },
  {
    brand: 'Proton Sports',
    models: [
      { name: 'Peacock 15 Elongated',   thickness_mm: 15, sort_order: 1 },
      { name: 'Peacock 13 Elongated',   thickness_mm: 13, sort_order: 2 },
      { name: 'Peacock 15 Widebody',    thickness_mm: 15, sort_order: 3 },
      { name: 'Peacock 13 Widebody',    thickness_mm: 13, sort_order: 4 },
    ],
  },
  {
    brand: 'Friday Pickleball',
    models: [
      { name: 'Aura Pro',               sort_order: 1 },
      { name: 'Aura',                   sort_order: 2 },
    ],
  },
  {
    brand: 'ProXR',
    models: [
      { name: 'Zane Navratil Signature 14', thickness_mm: 14, sort_order: 1 },
      { name: 'Zane Navratil The Standard', sort_order: 2 },
    ],
  },
];

async function run() {
  console.log('Loading brand IDs…');
  const { data: brands } = await s.from('paddle_brands').select('id, name');
  const brandMap = Object.fromEntries(brands.map(b => [b.name.toLowerCase(), b.id]));

  let inserted = 0, skipped = 0;

  for (const entry of CATALOG) {
    const brandId = brandMap[entry.brand.toLowerCase()];
    if (!brandId) { console.warn('  ⚠  Brand not found:', entry.brand); continue; }

    for (const model of entry.models) {
      const { error } = await s.from('paddle_models').upsert({
        brand_id:     brandId,
        name:         model.name,
        thickness_mm: model.thickness_mm ?? null,
        notes:        model.notes ?? null,
        sort_order:   model.sort_order ?? 99,
      }, { onConflict: 'brand_id,name' });

      if (error) { console.error('  ✗', entry.brand, model.name, error.message); }
      else inserted++;
    }
  }

  console.log(`\n✓  Upserted ${inserted} paddle models across ${CATALOG.length} brands.`);

  // Print summary
  const { data: summary } = await s
    .from('paddle_models')
    .select('brand_id, paddle_brands(name)')
    .order('brand_id');
  const counts = {};
  summary.forEach(r => { const n = r.paddle_brands?.name ?? '?'; counts[n] = (counts[n]||0)+1; });
  console.log('\nModels per brand:');
  Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([n,c])=>console.log(`  ${String(c).padStart(3)}  ${n}`));
}

run().catch(console.error);
