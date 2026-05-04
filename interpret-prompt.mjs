const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const prompt = process.env.PROMPT;

if (!prompt) {
  process.exit(0);
}

const COLLECTIONS = [
  { id: 'gid://shopify/Collection/647561019723', name: 'Main collection', handle: 'main-collection' },
  { id: 'gid://shopify/Collection/648284799307', name: 'Nuovi arrivi',    handle: 'nuovi-arrivi' },
  { id: 'gid://shopify/Collection/648311996747', name: 'Abbigliamento donna', handle: 'abbigliamento-donna' },
];

const systemPrompt = `
Sei un assistente che aiuta a gestire le collection Shopify del brand di moda N21.

Collection disponibili:
${COLLECTIONS.map(c => `- "${c.name}" (id: ${c.id})`).join('\n')}

I prodotti hanno due metafield:
- "collection": valori noti: "capsule", "show", "resort", "main collection"
- "season": valori noti: "fw26", "ss26", "fw25", "ss25" (fw=autunno/inverno, ss=primavera/estate, il numero è l'anno)

L'utente descrive in linguaggio naturale:
1. Su quali collection eseguire il riordino (se non specificato, usa tutte e tre)
2. Quale ordine di priorità applicare ai gruppi (collection + season)

Rispondi SOLO con un oggetto JSON valido nel seguente formato, senza testo aggiuntivo:
{
  "collections": ["<id1>", "<id2>"],
  "groups": [
    { "collection": "<valore_metafield>", "season": "<valore_metafield>" },
    ...
  ],
  "stockFirst": true
}

Regole:
- "collections": array degli ID delle collection da riordinare
- "groups": array dei gruppi in ordine di priorità (il primo è il più importante); i prodotti non appartenenti a nessun gruppo vanno in fondo
- "stockFirst": true significa che i prodotti con stock > 0 vengono prima di quelli esauriti, all'interno di ogni gruppo
- Interpreta liberamente stagioni e collection (es. "invernale 2026" = fw26, "primavera estate" = ss26, "capsule" = capsule, ecc.)
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
    max_tokens: 512,
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

// Validate it's valid JSON
try {
  JSON.parse(text);
} catch {
  console.error('Invalid JSON from Claude:', text);
  process.exit(1);
}

process.stdout.write(text);
