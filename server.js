const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEAVIATE_URL = process.env.WEAVIATE_URL || 'weaviate-production-a85c.up.railway.app';

if (!OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY environment variable is required');
    process.exit(1);
}

async function getDocumentCount() {
  return new Promise((resolve, reject) => {
    const query = {
      query: `{
        Aggregate {
          Document {
            meta {
              count
            }
          }
        }
      }`
    };

    const postData = JSON.stringify(query);

    const options = {
      hostname: WEAVIATE_URL,
      path: '/v1/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const count = parsed.data?.Aggregate?.Document?.[0]?.meta?.count || 0;
          resolve(count);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Weaviate count request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

async function getEmbedding(text) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: 'text-embedding-3-small',
      input: text
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': postData.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.data && parsed.data[0] && parsed.data[0].embedding) {
            resolve(parsed.data[0].embedding);
          } else {
            reject(new Error('No embedding in response'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('OpenAI request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

async function searchWeaviate(embedding, limit = 5) {
  return new Promise((resolve, reject) => {
    const query = {
      query: `{
        Get {
          Document(
            nearVector: {
              vector: ${JSON.stringify(embedding)}
              certainty: 0.5
            }
            limit: ${limit}
          ) {
            text
            title
            source
            document_id
            chunk_id
            chunk_index
            created_at
            _additional {
              certainty
              distance
            }
          }
        }
      }`
    };

    const postData = JSON.stringify(query);

    const options = {
      hostname: WEAVIATE_URL,
      path: '/v1/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Weaviate request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  if (req.method === 'GET' && req.url === '/count') {
    try {
      console.log(`[${new Date().toISOString()}] Document count request`);
      const count = await getDocumentCount();
      console.log(`  ✓ Total documents: ${count}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        total_documents: count,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      console.error('  ✗ Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // Delete all documents endpoint
  if (req.method === 'POST' && req.url === '/delete-all') {
    try {
      console.log(`[${new Date().toISOString()}] Delete all documents request`);

      // Delete all objects in Document class
      const mutation = {
        query: `mutation { Delete(class: "Document", where: {operator: GreaterThan, valueInt: 0, path: ["_id"]}) { successful } }`
      };

      const postData = JSON.stringify(mutation);
      const options = {
        hostname: WEAVIATE_URL,
        path: '/v1/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': postData.length
        }
      };

      const req2 = https.request(options, (res2) => {
        let data = '';
        res2.on('data', (chunk) => data += chunk);
        res2.on('end', () => {
          console.log('  ✓ All documents deleted');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success', message: 'All documents deleted' }));
        });
      });

      req2.on('error', (e) => {
        console.error('  ✗ Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });

      req2.write(postData);
      req2.end();
    } catch (error) {
      console.error('  ✗ Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/search') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const query = data.query;
        const limit = data.limit || 5;

        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Query is required' }));
          return;
        }

        console.log(`[${new Date().toISOString()}] Search: "${query}"`);

        const totalDocuments = await getDocumentCount();
        console.log(`  ✓ Knowledge base: ${totalDocuments} docs`);

        const embedding = await getEmbedding(query);
        console.log(`  ✓ Embedding: ${embedding.length} dims`);

        const weaviateResult = await searchWeaviate(embedding, limit);

        if (weaviateResult.errors) {
          console.log('  ✗ Weaviate errors:', weaviateResult.errors);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Weaviate query failed', details: weaviateResult.errors }));
          return;
        }

        const documents = weaviateResult.data?.Get?.Document || [];
        console.log(`  ✓ Results: ${documents.length}`);

        const results = documents.map((doc, idx) => ({
          rank: idx + 1,
          title: doc.title || 'Untitled',
          text: doc.text || '',
          source: doc.source || 'unknown',
          document_id: doc.document_id,
          chunk_id: doc.chunk_id,
          relevance_score: doc._additional?.certainty || 0,
          certainty: doc._additional?.certainty || 0,
          distance: doc._additional?.distance || 1
        }));

        const response = {
          status: 'success',
          query: query,
          total_results: results.length,
          total_documents_in_kb: totalDocuments,
          results: results,
          timestamp: new Date().toISOString()
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response, null, 2));

      } catch (error) {
        console.error('  ✗ Error:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });

  } else if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <head><title>RAG Search API</title></head>
        <body style="font-family: sans-serif; max-width: 800px; margin: 50px auto; padding: 20px;">
          <h1>🔍 RAG Search API</h1>
          <p>Direct Weaviate semantic search endpoint</p>

          <h2>Endpoints:</h2>
          <ul>
            <li><code>GET /</code> - This page</li>
            <li><code>GET /health</code> - Health check</li>
            <li><code>GET /count</code> - Get document count</li>
            <li><code>POST /search</code> - Search endpoint</li>
          </ul>

          <h2>Status:</h2>
          <p>✅ <strong>Running</strong></p>
          <p>Connected to Weaviate: <code>${WEAVIATE_URL}</code></p>
        </body>
      </html>
    `);

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 RAG Search API`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Weaviate: ${WEAVIATE_URL}`);
  console.log(`   Endpoints: /search, /count, /health`);
  console.log(`   Status: Running\n`);
});
