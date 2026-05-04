import { execFileSync, execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const STORE = 'numero-ventuno.myshopify.com';
const COLLECTION_ID = 'gid://shopify/Collection/647561019723';

const SHOPIFY_CMD = process.platform === 'win32' ? 'shopify.cmd' : 'shopify';

function runShopify(args) {
  const result = execFileSync(SHOPIFY_CMD, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response:\n' + result);
  return JSON.parse(jsonMatch[0]);
}

function shopifyQueryFile(query, allowMutations = false) {
  const tmpFile = join(tmpdir(), `shopify-query-${Date.now()}.graphql`);
  writeFileSync(tmpFile, query, 'utf8');
  try {
    const args = ['store', 'execute', '--store', STORE, '--query-file', tmpFile];
    if (allowMutations) args.push('--allow-mutations');
    return runShopify(args);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// Fetch all products with pagination
async function fetchAllProducts() {
  const products = [];
  let cursor = null;
  let page = 1;

  while (true) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `
      query {
        collection(id: "${COLLECTION_ID}") {
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

    console.log(`Fetching page ${page}...`);
    const data = shopifyQueryFile(query);
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

    console.log(`  Got ${edges.length} products (total so far: ${products.length})`);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    page++;
  }

  return products;
}

// Sort products according to priority rules
function sortProducts(products) {
  const groups = [
    { collection: 'capsule', season: 'fw26' },
    { collection: 'show',    season: 'ss26' },
    { collection: 'resort',  season: 'ss26' },
  ];

  function getGroupIndex(p) {
    for (let i = 0; i < groups.length; i++) {
      if (p.collection === groups[i].collection && p.season === groups[i].season) {
        return i;
      }
    }
    return groups.length; // other
  }

  return [...products].sort((a, b) => {
    const ga = getGroupIndex(a);
    const gb = getGroupIndex(b);
    if (ga !== gb) return ga - gb;
    // Same group: stock >= 1 before stock = 0
    const sa = a.stock >= 1 ? 0 : 1;
    const sb = b.stock >= 1 ? 0 : 1;
    return sa - sb;
  });
}

// Main
console.log('=== Fetching products ===');
const products = await fetchAllProducts();
console.log(`\nTotal products: ${products.length}`);

console.log('\n=== Sorting products ===');
const sorted = sortProducts(products);

// Show summary
console.log('\nFirst 15 after sort:');
sorted.slice(0, 15).forEach((p, i) => {
  console.log(`  ${i + 1}. [${p.collection || '-'}/${p.season || '-'}] stock=${p.stock} — ${p.title}`);
});
console.log('...');
console.log('\nLast 5:');
sorted.slice(-5).forEach((p, i) => {
  console.log(`  ${sorted.length - 4 + i}. [${p.collection || '-'}/${p.season || '-'}] stock=${p.stock} — ${p.title}`);
});

console.log('\n=== Executing reorder mutation ===');

// collectionReorderProducts supports up to 250 moves per call
const BATCH = 250;
for (let start = 0; start < sorted.length; start += BATCH) {
  const batch = sorted.slice(start, start + BATCH);
  const moves = batch
    .map((p, i) => `{ id: "${p.id}", newPosition: "${start + i}" }`)
    .join(',\n        ');

  const mutation = `
    mutation {
      collectionReorderProducts(id: "${COLLECTION_ID}", moves: [
        ${moves}
      ]) {
        job { id }
        userErrors { field message }
      }
    }
  `;

  console.log(`Sending batch positions ${start}–${start + batch.length - 1}...`);
  const result = shopifyQueryFile(mutation, true);
  const { userErrors, job } = result.collectionReorderProducts;

  if (userErrors.length > 0) {
    console.error('Errors:', JSON.stringify(userErrors, null, 2));
    process.exit(1);
  }
  console.log(`  Job ID: ${job?.id ?? 'N/A'} ✓`);
}

console.log('\n✅ Reorder completed successfully!');
