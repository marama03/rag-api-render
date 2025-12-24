const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEAVIATE_URL = process.env.WEAVIATE_URL || 'weaviate-production-a85c.up.railway.app';

// Chunking settings
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;
const MIN_CHUNK_SIZE = 100;

if (!OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY environment variable is required');
    process.exit(1);
}

// ============================================
// HELPER FUNCTIONS
// ============================================

// Split text into chunks with overlap
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let start = 0;

  // Clean the text
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length <= chunkSize) {
    return [text];
  }

  while (start < text.length) {
    let end = start + chunkSize;

    // Try to break at a sentence or word boundary
    if (end < text.length) {
      // Look for sentence end (. ! ?) within last 100 chars
      const searchStart = Math.max(start + chunkSize - 100, start);
      const searchText = text.substring(searchStart, end);
      const sentenceEnd = searchText.search(/[.!?]\s/);

      if (sentenceEnd !== -1) {
        end = searchStart + sentenceEnd + 1;
      } else {
        // Fall back to word boundary
        const lastSpace = text.lastIndexOf(' ', end);
        if (lastSpace > start + MIN_CHUNK_SIZE) {
          end = lastSpace;
        }
      }
    }

    const chunk = text.substring(start, end).trim();
    if (chunk.length >= MIN_CHUNK_SIZE) {
      chunks.push(chunk);
    }

    start = end - overlap;
    if (start >= text.length - MIN_CHUNK_SIZE) break;
  }

  return chunks;
}

// Generate unique IDs
function generateId() {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Get embedding from OpenAI
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
        'Content-Length': Buffer.byteLength(postData)
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
          } else if (parsed.error) {
            reject(new Error(parsed.error.message || 'OpenAI API error'));
          } else {
            reject(new Error('No embedding in response'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('OpenAI request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// Store objects in Weaviate (batch)
async function storeInWeaviate(objects) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ objects });

    const options = {
      hostname: WEAVIATE_URL,
      path: '/v1/batch/objects',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
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
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Weaviate batch store timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// Get document count (optionally filtered by client_id)
async function getDocumentCount(clientId = null) {
  return new Promise((resolve, reject) => {
    let whereClause = '';
    if (clientId) {
      whereClause = `(where: {path: ["client_id"], operator: Equal, valueText: "${clientId}"})`;
    }

    const query = {
      query: `{
        Aggregate {
          Document${whereClause} {
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
        'Content-Length': Buffer.byteLength(postData)
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
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Weaviate count request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// Search Weaviate with optional client_id filter
async function searchWeaviate(embedding, limit = 5, clientId = null) {
  return new Promise((resolve, reject) => {
    let whereClause = '';
    if (clientId) {
      whereClause = `where: {path: ["client_id"], operator: Equal, valueText: "${clientId}"}`;
    }

    const query = {
      query: `{
        Get {
          Document(
            nearVector: {
              vector: ${JSON.stringify(embedding)}
              certainty: 0.5
            }
            ${whereClause}
            limit: ${limit}
          ) {
            text
            title
            source
            client_id
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
        'Content-Length': Buffer.byteLength(postData)
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
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Weaviate request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// List documents with optional client_id filter
async function listDocuments(clientId = null) {
  return new Promise((resolve, reject) => {
    let whereClause = '';
    if (clientId) {
      whereClause = `(where: {path: ["client_id"], operator: Equal, valueText: "${clientId}"}, limit: 1000)`;
    } else {
      whereClause = '(limit: 1000)';
    }

    const query = {
      query: `{
        Get {
          Document${whereClause} {
            text
            title
            source
            client_id
            document_id
            chunk_id
            created_at
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
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.data?.Get?.Document || []);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Weaviate list request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// Delete documents by document_id (and optionally client_id for safety)
async function deleteDocument(documentId, clientId = null) {
  return new Promise((resolve, reject) => {
    // Build where filter - always filter by document_id, optionally also by client_id
    let whereFilter;
    if (clientId) {
      whereFilter = {
        operator: 'And',
        operands: [
          { path: ['document_id'], operator: 'Equal', valueText: documentId },
          { path: ['client_id'], operator: 'Equal', valueText: clientId }
        ]
      };
    } else {
      whereFilter = { path: ['document_id'], operator: 'Equal', valueText: documentId };
    }

    const deletePayload = {
      match: {
        class: 'Document',
        where: whereFilter
      },
      output: 'verbose',
      dryRun: false
    };

    const postData = JSON.stringify(deletePayload);

    const options = {
      hostname: WEAVIATE_URL,
      path: '/v1/batch/objects',
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Weaviate delete request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// Delete all documents for a client
async function deleteAllDocuments(clientId = null) {
  return new Promise((resolve, reject) => {
    let whereFilter;
    if (clientId) {
      whereFilter = { path: ['client_id'], operator: 'Equal', valueText: clientId };
    } else {
      whereFilter = { path: ['document_id'], operator: 'NotEqual', valueText: '__NONEXISTENT__' };
    }

    const deletePayload = {
      match: {
        class: 'Document',
        where: whereFilter
      },
      output: 'verbose',
      dryRun: false
    };

    const postData = JSON.stringify(deletePayload);

    const options = {
      hostname: WEAVIATE_URL,
      path: '/v1/batch/objects',
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Weaviate delete all request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// Parse request body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
  });
}

// Parse client_id from URL params or body
function getClientId(urlParams, bodyData) {
  return urlParams.get('client_id') || bodyData?.client_id || null;
}

// ============================================
// HTTP SERVER
// ============================================

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Client-ID');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Parse URL
  const urlParts = req.url.split('?');
  const pathname = urlParts[0];
  const urlParams = new URLSearchParams(urlParts[1] || '');

  // ============================================
  // GET /health - Health check
  // ============================================
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '2.0.0',
      multi_tenant: true,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // ============================================
  // GET /count - Get document count
  // ============================================
  if (req.method === 'GET' && pathname === '/count') {
    try {
      const clientId = urlParams.get('client_id');
      console.log(`[${new Date().toISOString()}] Count request${clientId ? ` for client: ${clientId}` : ' (all clients)'}`);

      const count = await getDocumentCount(clientId);
      console.log(`  ✓ Total documents: ${count}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        client_id: clientId || 'all',
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

  // ============================================
  // GET /documents - List all documents
  // ============================================
  if (req.method === 'GET' && pathname === '/documents') {
    try {
      const clientId = urlParams.get('client_id');
      console.log(`[${new Date().toISOString()}] List documents${clientId ? ` for client: ${clientId}` : ' (all clients)'}`);

      const documents = await listDocuments(clientId);
      console.log(`  ✓ Found ${documents.length} documents`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        client_id: clientId || 'all',
        documents: documents,
        total: documents.length
      }));
    } catch (error) {
      console.error('  ✗ Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ============================================
  // POST /ingest - Ingest document (NEW!)
  // ============================================
  if (req.method === 'POST' && pathname === '/ingest') {
    const body = await parseBody(req);

    try {
      let data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      const { text, title, source, client_id } = data;

      // Validate required fields
      if (!text || text.trim().length < 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Text is required and must be at least 10 characters' }));
        return;
      }

      if (!client_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'client_id is required' }));
        return;
      }

      console.log(`[${new Date().toISOString()}] Ingest: "${title || 'Untitled'}" for client: ${client_id}`);
      console.log(`  Text length: ${text.length} chars`);

      // Generate document ID
      const documentId = `doc_${generateId()}`;
      const createdAt = new Date().toISOString();

      // Chunk the text
      const chunks = chunkText(text);
      console.log(`  ✓ Chunked into ${chunks.length} pieces`);

      // Generate embeddings and prepare objects
      const objects = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`  Embedding chunk ${i + 1}/${chunks.length}...`);

        const embedding = await getEmbedding(chunk);

        objects.push({
          class: 'Document',
          properties: {
            text: chunk,
            title: title || 'Untitled',
            source: source || 'upload',
            client_id: client_id,
            document_id: documentId,
            chunk_id: `${documentId}_chunk_${String(i + 1).padStart(3, '0')}`,
            chunk_index: i,
            created_at: createdAt
          },
          vector: embedding
        });
      }

      console.log(`  ✓ All embeddings generated`);

      // Store in Weaviate
      const result = await storeInWeaviate(objects);

      // Check for errors
      const errors = result.filter(r => r.result?.errors);
      if (errors.length > 0) {
        console.error('  ✗ Some chunks failed to store:', errors);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Some chunks failed to store',
          details: errors.map(e => e.result.errors)
        }));
        return;
      }

      console.log(`  ✓ Stored ${objects.length} chunks in Weaviate`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        message: 'Document ingested successfully',
        client_id: client_id,
        document_id: documentId,
        title: title || 'Untitled',
        chunks_created: chunks.length,
        total_characters: text.length,
        timestamp: createdAt
      }));

    } catch (error) {
      console.error('  ✗ Ingest error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ============================================
  // POST/GET /search - Search documents
  // ============================================
  if ((req.method === 'POST' || req.method === 'GET') && pathname === '/search') {
    const body = await parseBody(req);

    try {
      let query = null;
      let limit = 5;
      let clientId = urlParams.get('client_id');

      // Parse query from URL params or body
      // Support multiple common field names for the query
      if (urlParams.get('query') || urlParams.get('q') || urlParams.get('message') || urlParams.get('input')) {
        query = urlParams.get('query') || urlParams.get('q') || urlParams.get('message') || urlParams.get('input');
        limit = parseInt(urlParams.get('limit')) || 5;
      } else if (body && body.trim().startsWith('{')) {
        try {
          const data = JSON.parse(body);

          // Assistable.ai wraps params in "args" object: {"args":{"query":"..."}, "metadata":{...}}
          const params = data.args || data;

          // Accept: query, q, message, input, text, question, search
          query = params.query || params.q || params.message || params.input || params.text || params.question || params.search;

          // Filter out literal "null" string that Assistable.ai sends for empty values
          if (query === 'null' || query === null) query = null;

          limit = params.limit || data.limit || 5;
          clientId = clientId || params.client_id || data.client_id;
        } catch (e) {
          console.log('  ⚠ Failed to parse JSON body:', e.message);
        }
      }

      if (!query && body) {
        const formParams = new URLSearchParams(body);
        const formQuery = formParams.get('query') || formParams.get('q') || formParams.get('message') || formParams.get('input');
        if (formQuery) {
          query = formQuery;
          limit = parseInt(formParams.get('limit')) || 5;
          clientId = clientId || formParams.get('client_id');
        }
      }

      if (!query) {
        // Check if this is an Assistable.ai Initialize test (sends query: "null")
        const isInitializeTest = body && body.includes('"query":"null"');

        if (isInitializeTest) {
          // Return success for Initialize test
          console.log(`  ✓ Assistable.ai Initialize test - returning success`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'success',
            message: 'RAG API connected successfully! Ready to receive queries.',
            api_version: '2.0.0',
            endpoints: {
              search: '/search (POST)',
              count: '/count (GET)',
              ingest: '/ingest (POST)',
              documents: '/documents (GET)',
              delete: '/delete/:id (POST)'
            }
          }));
          return;
        }

        console.log(`  ⚠ No query found. Body received: ${body ? body.substring(0, 200) : '(empty)'}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Query is required',
          hint: 'Send JSON with one of: query, q, message, input, text, question, search',
          example: { query: 'your search query', limit: 5 },
          received_body: body ? body.substring(0, 100) : null
        }));
        return;
      }

      console.log(`[${new Date().toISOString()}] Search: "${query}"${clientId ? ` (client: ${clientId})` : ''}`);

      const totalDocuments = await getDocumentCount(clientId);
      console.log(`  ✓ Knowledge base: ${totalDocuments} docs`);

      const embedding = await getEmbedding(query);
      console.log(`  ✓ Embedding: ${embedding.length} dims`);

      const weaviateResult = await searchWeaviate(embedding, limit, clientId);

      if (weaviateResult.errors) {
        console.log('  ✗ Weaviate errors:', weaviateResult.errors);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Search failed', details: weaviateResult.errors }));
        return;
      }

      const documents = weaviateResult.data?.Get?.Document || [];
      console.log(`  ✓ Results: ${documents.length}`);

      const results = documents.map((doc, idx) => ({
        rank: idx + 1,
        title: doc.title || 'Untitled',
        text: doc.text || '',
        source: doc.source || 'unknown',
        client_id: doc.client_id,
        document_id: doc.document_id,
        chunk_id: doc.chunk_id,
        relevance_score: doc._additional?.certainty || 0,
        certainty: doc._additional?.certainty || 0,
        distance: doc._additional?.distance || 1
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        query: query,
        client_id: clientId || 'all',
        total_results: results.length,
        total_documents_in_kb: totalDocuments,
        results: results,
        timestamp: new Date().toISOString()
      }));

    } catch (error) {
      console.error('  ✗ Search error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ============================================
  // POST /delete/:document_id - Delete document
  // ============================================
  if (req.method === 'POST' && pathname.startsWith('/delete/')) {
    const documentId = pathname.split('/delete/')[1];
    const body = await parseBody(req);

    try {
      let clientId = urlParams.get('client_id');
      if (body) {
        try {
          const data = JSON.parse(body);
          clientId = clientId || data.client_id;
        } catch (e) {}
      }

      console.log(`[${new Date().toISOString()}] Delete document: ${documentId}${clientId ? ` (client: ${clientId})` : ''}`);

      const result = await deleteDocument(documentId, clientId);

      if (result.error || result.errors) {
        const errorMsg = result.error?.message || JSON.stringify(result.errors);
        console.error('  ✗ Weaviate errors:', errorMsg);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Deletion failed', error: errorMsg }));
        return;
      }

      const successful = result.results?.successful || result.matches || 0;
      console.log(`  ✓ Deleted ${successful} chunks`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        message: 'Document deleted',
        document_id: documentId,
        deleted_count: successful
      }));

    } catch (error) {
      console.error('  ✗ Delete error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ============================================
  // DELETE /documents - Delete all documents
  // ============================================
  if (req.method === 'DELETE' && pathname === '/documents') {
    const body = await parseBody(req);

    try {
      let clientId = urlParams.get('client_id');
      if (body) {
        try {
          const data = JSON.parse(body);
          clientId = clientId || data.client_id;
        } catch (e) {}
      }

      console.log(`[${new Date().toISOString()}] Delete all documents${clientId ? ` for client: ${clientId}` : ' (ALL CLIENTS!)'}`);

      const result = await deleteAllDocuments(clientId);

      if (result.error || result.errors) {
        const errorMsg = result.error?.message || JSON.stringify(result.errors);
        console.error('  ✗ Weaviate errors:', errorMsg);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Deletion failed', error: errorMsg }));
        return;
      }

      const successful = result.results?.successful || result.matches || 0;
      console.log(`  ✓ Deleted ${successful} chunks`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        message: clientId ? `All documents for client ${clientId} deleted` : 'All documents deleted',
        client_id: clientId || 'all',
        deleted_count: successful
      }));

    } catch (error) {
      console.error('  ✗ Delete all error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ============================================
  // GET / - API info page
  // ============================================
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <head><title>RAG API v2.0</title></head>
        <body style="font-family: sans-serif; max-width: 900px; margin: 50px auto; padding: 20px;">
          <h1>🔍 RAG API v2.0 - Multi-Tenant</h1>
          <p>Complete RAG system with document ingestion and semantic search</p>

          <h2>Endpoints:</h2>
          <table border="1" cellpadding="10" style="border-collapse: collapse; width: 100%;">
            <tr><th>Method</th><th>Endpoint</th><th>Description</th></tr>
            <tr><td>GET</td><td>/health</td><td>Health check</td></tr>
            <tr><td>GET</td><td>/count?client_id=xxx</td><td>Get document count</td></tr>
            <tr><td>GET</td><td>/documents?client_id=xxx</td><td>List all documents</td></tr>
            <tr><td>POST</td><td>/ingest</td><td>Ingest document (requires client_id)</td></tr>
            <tr><td>POST/GET</td><td>/search?client_id=xxx</td><td>Search documents</td></tr>
            <tr><td>POST</td><td>/delete/:id?client_id=xxx</td><td>Delete document by ID</td></tr>
            <tr><td>DELETE</td><td>/documents?client_id=xxx</td><td>Delete all documents</td></tr>
          </table>

          <h2>Ingest Example:</h2>
          <pre style="background: #f4f4f4; padding: 15px; border-radius: 5px;">
POST /ingest
{
  "client_id": "helen",
  "title": "Document Title",
  "source": "upload",
  "text": "Your document content here..."
}
          </pre>

          <h2>Search Example:</h2>
          <pre style="background: #f4f4f4; padding: 15px; border-radius: 5px;">
POST /search
{
  "client_id": "helen",
  "query": "What is this about?",
  "limit": 5
}
          </pre>

          <h2>Status:</h2>
          <p>✅ <strong>Running</strong></p>
          <p>Weaviate: <code>${WEAVIATE_URL}</code></p>
          <p>Multi-tenant: <strong>Enabled</strong></p>
        </body>
      </html>
    `);
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 RAG API v2.0 - Multi-Tenant`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Weaviate: ${WEAVIATE_URL}`);
  console.log(`   Multi-tenant: Enabled`);
  console.log(`   Endpoints: /ingest, /search, /count, /documents, /delete`);
  console.log(`   Status: Running\n`);
});
