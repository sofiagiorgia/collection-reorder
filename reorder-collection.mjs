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
import { existsSync, readFileSync } from 'fs';

let config = DEFAULT_CONFIG;
if (existsSync('reorder-config.json')) {
  try {
    config = JSON.parse(readFileSync('reorder-config.json', 'utf8'));
    console.log('Using custom config from prompt.');
  } catch {
    console.warn('Invalid reorder-config.json, using default.');
  }
}

console.log('Config:', JSON.stringify(config, null, 2));

const API_URL = `https://${STORE}/admin/api/2024-01/graphql.json`;

async function shopifyQuery(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
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
          products(first: 250${afterClause}) {
            edges {
              node {
                id
                title
                totalInventory
                metaCol: metafield(namespace: "custom", key: "collection") { value }
                metaSeason: metafield(namespace: "custom", key: "season") { value }
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
    const { edges, pageInfo } = data.collection.products;

    for (const { node } of edges) {
      products.push({
        id: node.id,
        title: node.title,
        stock: node.totalInventory ?? 0,
        collection: node.metaCol?.value?.trim().toLowerCase() ?? '',
        season: node.metaSeason?.value?.trim().toLowerCase() ?? '',
      });
    }

    console.log(`    Got ${edges.length} products (total: ${products.length})`);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    page++;
  }

  return products;
}

function sortProducts(products, groups, stockFirst) {
  function getGroupIndex(p) {
    for (let i = 0; i < groups.length; i++) {
      if (p.collection === groups[i].collection && p.season === groups[i].season) {
        return i;
      }
    }
    return groups.length;
  }

  return [...products].sort((a, b) => {
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

async function reorderCollection(collectionId) {
  const name = COLLECTION_NAMES[collectionId] ?? collectionId;
  console.log(`\n=== ${name} ===`);

  console.log('Fetching products...');
  const products = await fetchAllProducts(collectionId);
  console.log(`Total: ${products.length}`);

  const sorted = sortProducts(products, config.groups, config.stockFirst);

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
      console.error('Errors:', JSON.stringify(userErrors, null, 2));
      process.exit(1);
    }
    console.log(`  Job ID: ${job?.id ?? 'N/A'} ✓`);
  }
}

for (const collectionId of config.collections) {
  await reorderCollection(collectionId);
}

console.log('\n✅ All collections reordered successfully!');
