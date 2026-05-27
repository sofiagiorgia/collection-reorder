const STORE = 'numero-ventuno.myshopify.com';
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('Missing SHOPIFY_ACCESS_TOKEN environment variable');
  process.exit(1);
}

// Default config (used for scheduled runs)
const DEFAULT_CONFIG = {
  collections: [
    'gid://shopify/Collection/647561019723',
    'gid://shopify/Collection/648284799307',
    'gid://shopify/Collection/648311996747',
  ],
  groups: [
    { collection: 'capsule', season: 'fw26' },
    { collection: 'show',    season: 'ss26' },
    { collection: 'resort',  season: 'ss26' },
  ],
  stockFirst: true,
};

const COLLECTION_NAMES = {
  'gid://shopify/Collection/647561019723': 'Main collection',
  'gid://shopify/Collection/648284799307': 'Nuovi arrivi',
  'gid://shopify/Collection/648311996747': 'Abbigliamento donna',
};

// Load config: from reorder-config.json (written by interpret-prompt step) or default
import { existsSync, readFileSync, appendFileSync } from 'fs';

let config = DEFAULT_CONFIG;
if (existsSync('reorder-config.json')) {
  try {
    config = JSON.parse(readFileSync('reorder-config.json', 'utf8'));
    console.log('Using custom config from prompt.');
  } catch {
    console.warn('Invalid reorder-config.json, using default.');
  }
}

// Extract unique metafield keys referenced across all groups
function getGroupKeys(groups) {
  const keys = new Set();
  for (const group of groups) {
    for (const key of Object.keys(group)) keys.add(key);
  }
  return [...keys];
}

const groupKeys = getGroupKeys(config.groups);
const metafieldsFragment = groupKeys.length > 0
  ? `metafields(identifiers: [${groupKeys.map(k => `{namespace: "custom", key: ${JSON.stringify(k)}}`).join(', ')}]) { key value }`
  : '';

console.log('Config:', JSON.stringify(config, null, 2));

const API_URL = `https://${STORE}/admin/api/2024-01/graphql.json`;

function writeSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
}

async function shopifyQuery(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Shopify API HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`);
  return json.data;
}

async function fetchAllProducts(collectionId) {
  const products = [];
  let cursor = null;
  let page = 1;

  while (true) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `
      query {
        collection(id: "${collectionId}") {
          title
          products(first: 250${afterClause}) {
            edges {
              node {
                id
                title
                totalInventory
                ${metafieldsFragment}
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `;

    console.log(`  Fetching page ${page}...`);
    const data = await shopifyQuery(query);

    if (!data.collection) {
      throw new Error(`Collection non trovata: ${collectionId}\n   Verifica che l'ID nel config sia corretto e che la collection esista nel negozio.`);
    }

    const { edges, pageInfo } = data.collection.products;

    for (const { node } of edges) {
      const meta = {};
      for (const mf of (node.metafields ?? [])) {
        meta[mf.key] = mf.value?.trim().toLowerCase() ?? '';
      }
      products.push({
        id: node.id,
        title: node.title,
        stock: node.totalInventory ?? 0,
        ...meta,
      });
    }

    console.log(`    Got ${edges.length} products (total: ${products.length})`);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    page++;
  }

  return products;
}

function checkGroupCoverage(products, groups) {
  if (groups.length === 0) return [];

  const rows = [];
  for (const group of groups) {
    const count = products.filter(p =>
      Object.entries(group).every(([k, v]) => p[k] === (v?.trim().toLowerCase() ?? ''))
    ).length;
    const label = JSON.stringify(group);
    if (count === 0) {
      console.warn(`⚠️  Gruppo ${label}: nessun prodotto corrisponde — controlla chiave e valore del metafield`);
      rows.push({ label, count, warning: true });
    } else {
      console.log(`  Gruppo ${label}: ${count} prodotti`);
      rows.push({ label, count, warning: false });
    }
  }

  const unmatched = products.filter(p =>
    !groups.some(g => Object.entries(g).every(([k, v]) => p[k] === (v?.trim().toLowerCase() ?? '')))
  ).length;
  if (unmatched > 0) {
    console.log(`  Senza gruppo (fondo): ${unmatched} prodotti`);
    rows.push({ label: '_senza gruppo_', count: unmatched, warning: false });
  }

  return rows;
}

function sortProducts(products, groups, stockFirst, pinnedProducts = [], oosAtEnd = false) {
  // Matches a product against a group: all keys in the group must match the product's field
  function getGroupIndex(p) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const matches = Object.entries(g).every(([key, val]) =>
        p[key] === (val?.trim().toLowerCase() ?? '')
      );
      if (matches) return i;
    }
    return groups.length;
  }

  // Identify pinned products by partial title match (case-insensitive)
  const pinned = [];
  const remaining = [];

  for (const p of products) {
    const pin = pinnedProducts.find(pp =>
      p.title.toLowerCase().includes(pp.title.toLowerCase())
    );
    if (pin) {
      pinned.push({ product: p, position: pin.position ?? pinned.length });
    } else {
      remaining.push(p);
    }
  }

  // Sort remaining: oosAtEnd pulls all OOS after all in-stock groups
  let sorted;
  if (oosAtEnd) {
    const inStock = remaining.filter(p => p.stock >= 1);
    const outOfStock = remaining.filter(p => p.stock < 1);
    inStock.sort((a, b) => getGroupIndex(a) - getGroupIndex(b));
    outOfStock.sort((a, b) => getGroupIndex(a) - getGroupIndex(b));
    sorted = [...inStock, ...outOfStock];
  } else {
    sorted = [...remaining];
    sorted.sort((a, b) => {
      const ga = getGroupIndex(a);
      const gb = getGroupIndex(b);
      if (ga !== gb) return ga - gb;
      if (stockFirst) {
        const sa = a.stock >= 1 ? 0 : 1;
        const sb = b.stock >= 1 ? 0 : 1;
        if (sa !== sb) return sa - sb;
      }
      return 0;
    });
  }

  // Insert pinned products at their positions
  pinned.sort((a, b) => a.position - b.position);
  const result = [...sorted];
  for (const { product, position } of pinned) {
    const pos = Math.min(position, result.length);
    result.splice(pos, 0, product);
  }

  return result;
}

async function ensureManualSort(collectionId) {
  const query = `query { collection(id: "${collectionId}") { sortOrder } }`;
  const data = await shopifyQuery(query);
  if (!data.collection) {
    throw new Error(`Collection non trovata durante verifica sortOrder: ${collectionId}`);
  }
  if (data.collection.sortOrder !== 'MANUAL') {
    console.log('  Sort order is not manual — updating...');
    const mutation = `
      mutation {
        collectionUpdate(input: { id: "${collectionId}", sortOrder: MANUAL }) {
          userErrors { field message }
        }
      }
    `;
    const result = await shopifyQuery(mutation);
    if (result.collectionUpdate.userErrors.length > 0) {
      throw new Error(`Errore impostando sort manuale: ${JSON.stringify(result.collectionUpdate.userErrors)}`);
    }
    console.log('  Sort order set to manual ✓');
  }
}

// Accumulate summary rows
const summaryRows = [];

async function reorderCollection(collectionId) {
  const name = COLLECTION_NAMES[collectionId] ?? collectionId;
  console.log(`\n=== ${name} ===`);

  await ensureManualSort(collectionId);

  console.log('Fetching products...');
  const products = await fetchAllProducts(collectionId);
  console.log(`Total: ${products.length}`);

  const coverageRows = checkGroupCoverage(products, config.groups);
  const hasWarning = coverageRows.some(r => r.warning);

  const sorted = sortProducts(products, config.groups, config.stockFirst, config.pinnedProducts ?? [], config.oosAtEnd ?? false);

  const BATCH = 250;
  for (let start = 0; start < sorted.length; start += BATCH) {
    const batch = sorted.slice(start, start + BATCH);
    const moves = batch.map((p, i) => ({ id: p.id, newPosition: String(start + i) }));

    const mutation = `
      mutation reorder($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
          job { id }
          userErrors { field message }
        }
      }
    `;

    console.log(`Sending positions ${start}–${start + batch.length - 1}...`);
    const result = await shopifyQuery(mutation, { id: collectionId, moves });
    const { userErrors, job } = result.collectionReorderProducts;

    if (userErrors.length > 0) {
      throw new Error(`Errore nel riordino di ${name}: ${JSON.stringify(userErrors)}`);
    }
    console.log(`  Job ID: ${job?.id ?? 'N/A'} ✓`);
  }

  summaryRows.push({ name, total: products.length, coverageRows, warning: hasWarning });
}

try {
  for (const collectionId of config.collections) {
    await reorderCollection(collectionId);
  }
} catch (err) {
  console.error(`\n❌ Errore: ${err.message}`);
  writeSummary(`## ❌ Errore durante il riordino\n\n\`\`\`\n${err.message}\n\`\`\`\n`);
  process.exit(1);
}

console.log('\n✅ All collections reordered successfully!');

// Write step summary
const configSource = existsSync('reorder-config.json') ? 'prompt personalizzato' : 'configurazione di default';
const collectionSections = summaryRows.map(({ name, total, coverageRows, warning }) => {
  const icon = warning ? '⚠️' : '✅';
  const groupTable = coverageRows.length > 0
    ? `\n  | Gruppo | Prodotti |\n  |--------|----------|\n${coverageRows.map(r => `  | ${r.warning ? '⚠️ ' : ''}${r.label} | ${r.count} |`).join('\n')}`
    : '';
  return `- ${icon} **${name}** — ${total} prodotti${groupTable}`;
}).join('\n\n');

writeSummary(`## Riordino N21 completato

**Config usata:** ${configSource}

${collectionSections}
`);
