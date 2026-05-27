const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const STORE = 'numero-ventuno.myshopify.com';
const prompt = process.env.PROMPT;

if (!prompt) {
  process.exit(0);
}

// Fetch all collections from Shopify
async function fetchCollections() {
  const collections = [];
  let cursor = null;

  while (true) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `
      query {
        collections(first: 250${afterClause}) {
          edges {
            node { id title handle }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const res = await fetch(`https://${STORE}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query }),
    });
    const json = await res.json();
    const { edges, pageInfo } = json.data.collections;
    for (const { node } of edges) collections.push(node);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return collections;
}

const collections = await fetchCollections();

const systemPrompt = `
Sei un assistente che aiuta a gestire le collection Shopify del brand di moda N21.

Collection disponibili nel negozio:
${collections.map(c => `- "${c.title}" (handle: ${c.handle}, id: ${c.id})`).join('\n')}

I prodotti hanno i seguenti metafield (namespace "custom"):
- "collection": valori noti: "capsule", "show", "resort", "main collection"
- "season": valori noti: "fw26", "ss26", "fw25", "ss25" (fw=autunno/inverno, ss=primavera/estate, il numero è l'anno)
- "gender": valori noti: "donna", "uomo", "unisex" (e varianti simili)

L'utente descrive in linguaggio naturale:
1. Su quali collection eseguire il riordino
2. Quale ordine di priorità applicare ai gruppi (puoi filtrare per uno o più metafield)
3. Eventualmente, prodotti specifici da posizionare in una posizione precisa

Rispondi SOLO con un oggetto JSON valido nel seguente formato, senza testo aggiuntivo:
{
  "collections": ["<id1>", "<id2>"],
  "pinnedProducts": [
    { "title": "<parte del titolo>", "position": 0 }
  ],
  "groups": [
    { "collection": "<valore_metafield>", "season": "<valore_metafield>" },
    { "gender": "<valore_metafield>" }
  ],
  "stockFirst": true,
  "oosAtEnd": false
}

Regole:
- "collections": array degli ID delle collection da riordinare; se l'utente non specifica, usa tutte
- "pinnedProducts": prodotti da bloccare in una posizione specifica (0 = primo). Ometti se non richiesto
- "groups": array dei gruppi in ordine di priorità; ogni gruppo può filtrare su qualsiasi combinazione di metafield (collection, season, gender, ecc.); tutti i campi specificati nel gruppo devono corrispondere; i prodotti senza gruppo vanno in fondo
- "stockFirst": true = prodotti in stock prima degli esauriti, all'interno di ogni gruppo (ignorato se oosAtEnd è true)
- "oosAtEnd": true = tutti i prodotti out-of-stock vengono messi alla fine di tutto, dopo tutti gli in-stock di ogni gruppo
- Interpreta liberamente stagioni (es. "invernale 2026" = fw26, "primavera estate" = ss26)
- Interpreta liberamente il gender (es. "Donna" = "donna", "femminile" = "donna")
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
  console.error('Anthropic API error:', await res.text());
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
  console.error('Invalid JSON from Claude:', text);
  process.exit(1);
}

if (!Array.isArray(parsed.collections) || !Array.isArray(parsed.groups)) {
  console.error('Config non valida da Claude:', text);
  process.exit(1);
}

process.stdout.write(text);
