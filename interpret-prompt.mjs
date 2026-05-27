const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const STORE = 'numero-ventuno.myshopify.com';
const prompt = process.env.PROMPT;

if (!prompt) {
  process.exit(0);
}

import { appendFileSync } from 'fs';

function writeSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
}

async function shopifyQuery(query) {
  const res = await fetch(`https://${STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify API HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchCollections() {
  const collections = [];
  let cursor = null;

  while (true) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const data = await shopifyQuery(`
      query {
        collections(first: 250${afterClause}) {
          edges { node { id title handle } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `);
    const { edges, pageInfo } = data.collections;
    for (const { node } of edges) collections.push(node);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return collections;
}

async function fetchProductMetafieldDefinitions() {
  try {
    const data = await shopifyQuery(`
      query {
        metafieldDefinitions(first: 100, ownerType: PRODUCT) {
          edges { node { namespace key name } }
        }
      }
    `);
    return (data?.metafieldDefinitions?.edges ?? []).map(({ node }) => node);
  } catch (err) {
    console.error(`⚠️  Impossibile leggere i metafield definitions (permessi insufficienti?): ${err.message}`);
    return [];
  }
}

const [collections, metafieldDefs] = await Promise.all([
  fetchCollections(),
  fetchProductMetafieldDefinitions(),
]);

const metafieldList = metafieldDefs.length > 0
  ? metafieldDefs.map(m => `- key: "${m.key}" (nome: "${m.name}", namespace: "${m.namespace}")`).join('\n')
  : '- Nessun metafield definito trovato; usa i nomi esatti indicati dall\'utente.';

const systemPrompt = `
Sei un assistente che aiuta a gestire le collection Shopify del brand di moda N21.

Collection disponibili nel negozio:
${collections.map(c => `- "${c.title}" (handle: ${c.handle}, id: ${c.id})`).join('\n')}

Metafield definiti sui prodotti:
${metafieldList}

I valori dei metafield sono stringhe; nel confronto verranno normalizzati in minuscolo, quindi scrivi sempre i valori in minuscolo nel JSON.

L'utente descrive in linguaggio naturale:
1. Su quali collection eseguire il riordino
2. Quale ordine di priorità applicare ai gruppi (puoi usare qualsiasi metafield)
3. Eventualmente, prodotti specifici da posizionare in una posizione precisa

Rispondi SOLO con un oggetto JSON valido nel seguente formato, senza testo aggiuntivo:
{
  "collections": ["<id1>", "<id2>"],
  "pinnedProducts": [
    { "title": "<parte del titolo>", "position": 0 }
  ],
  "groups": [
    { "<chiave_metafield>": "<valore>", "<chiave_metafield2>": "<valore2>" }
  ],
  "stockFirst": true,
  "oosAtEnd": false
}

Regole:
- "collections": array degli ID delle collection da riordinare; se l'utente non specifica, usa tutte
- "pinnedProducts": prodotti da bloccare in una posizione specifica (0 = primo). Ometti se non richiesto
- "groups": ogni elemento è un oggetto con una o più coppie chiave-valore metafield; un prodotto appartiene al gruppo se tutti i campi specificati corrispondono; i gruppi sono in ordine di priorità; i prodotti senza gruppo vanno in fondo
- "stockFirst": true = in-stock prima degli OOS, all'interno di ogni gruppo (ignorato se oosAtEnd è true)
- "oosAtEnd": true = tutti i prodotti OOS finiscono dopo tutti gli in-stock, indipendentemente dal gruppo
- Interpreta liberamente le stagioni (es. "invernale 2026" = "fw26", "primavera estate" = "ss26")
- Cerca il nome della collection anche per somiglianza (es. "accessori" = "Accessori donna")
`;

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`Anthropic API HTTP ${res.status}: ${body}`);
  process.exit(1);
}

const data = await res.json();
let text = data.content[0].text.trim();

// Strip markdown code blocks if present
const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
if (jsonMatch) text = jsonMatch[1].trim();

let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  console.error('Claude ha restituito JSON non valido:');
  console.error(text);
  writeSummary(`## ❌ Errore — JSON non valido\n\n**Prompt:** ${prompt}\n\n**Risposta di Claude:**\n\`\`\`\n${text}\n\`\`\`\n`);
  process.exit(1);
}

if (!Array.isArray(parsed.collections) || !Array.isArray(parsed.groups)) {
  console.error('Config mancante di "collections" o "groups":');
  console.error(JSON.stringify(parsed, null, 2));
  writeSummary(`## ❌ Errore — config incompleta\n\n**Prompt:** ${prompt}\n\n**Config generata:**\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n`);
  process.exit(1);
}

// Warn if any group key is not among known metafield definitions
const knownKeys = new Set(metafieldDefs.map(m => m.key));
const unknownKeys = [];
if (knownKeys.size > 0) {
  for (const group of parsed.groups) {
    for (const key of Object.keys(group)) {
      if (!knownKeys.has(key)) unknownKeys.push(key);
    }
  }
  if (unknownKeys.length > 0) {
    console.error(`⚠️  Attenzione: i seguenti metafield usati nei gruppi non risultano definiti nel negozio: ${unknownKeys.join(', ')}`);
    console.error(`   Metafield disponibili: ${[...knownKeys].join(', ')}`);
  }
}

// Log generated config to stderr (visible in Actions log even when stdout goes to file)
console.error('=== Config generata da Claude ===');
console.error(JSON.stringify(parsed, null, 2));

const warningSection = unknownKeys.length > 0
  ? `\n> ⚠️ **Attenzione:** i metafield \`${unknownKeys.join('`, `')}\` non sono definiti nel negozio. Il riordino potrebbe non fare quello che ti aspetti.\n`
  : '';

writeSummary(`## Interpretazione prompt

**Prompt ricevuto:** ${prompt}

${warningSection}
**Config generata:**
\`\`\`json
${JSON.stringify(parsed, null, 2)}
\`\`\`

**Metafield disponibili nel negozio:** ${knownKeys.size > 0 ? [...knownKeys].map(k => `\`${k}\``).join(', ') : '_nessuno_'}
`);

process.stdout.write(text);
