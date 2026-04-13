# JavaScript SDK

The `@sheets-banco/sdk` package provides a typed client for the sheets.banco API. Works in both browser and Node.js 18+.

## Installation

```bash
npm install @sheets-banco/sdk
```

## Quick Start

```typescript
import { SheetsBanco } from '@sheets-banco/sdk';

const db = new SheetsBanco({
  apiId: 'your-api-id',
  baseUrl: 'http://localhost:3000', // optional, defaults to localhost
  bearerToken: 'optional-token',    // if the API requires auth
});

// Read all rows
const rows = await db.read();

// Read with pagination
const page = await db.read({ limit: 10, offset: 20, sort_by: 'name' });

// Search (AND — all conditions must match)
const results = await db.search({ name: 'Alice', age: '>25' });

// Search (OR — any condition matches)
const any = await db.searchOr({ name: 'Alice', name: 'Bob' });

// Create rows
const { created } = await db.create({ name: 'Charlie', age: '28' });
// or multiple:
const { created } = await db.create([
  { name: 'Charlie', age: '28' },
  { name: 'Diana', age: '32' },
]);

// Update rows where name = Alice
const { updated } = await db.update('name', 'Alice', { age: '31' });

// Delete rows where name = Alice
const { deleted } = await db.delete('name', 'Alice');

// Get column names
const columns = await db.keys();

// Get row count
const { rows: count } = await db.count();
```

## Configuration

```typescript
const db = new SheetsBanco({
  apiId: 'clx123abc',                        // required
  baseUrl: 'https://api.yoursite.com',        // optional
  bearerToken: 'secret-token',               // optional
});
```

## Error Handling

```typescript
import { SheetsBanco, SheetsBancoError, NetworkError } from '@sheets-banco/sdk';

try {
  const rows = await db.read();
} catch (error) {
  if (error instanceof SheetsBancoError) {
    console.error(error.status);  // HTTP status code
    console.error(error.code);    // Error code (e.g. 'NOT_FOUND')
    console.error(error.message); // Human-readable message
  }
  if (error instanceof NetworkError) {
    console.error('Network failed:', error.message);
  }
}
```

## Multi-Sheet Support

Access different tabs within the same spreadsheet:

```typescript
const sheet1 = await db.read({ sheet: 'Products' });
const sheet2 = await db.read({ sheet: 'Orders' });
const cols = await db.keys('Products');
```
