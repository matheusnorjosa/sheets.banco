import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const spreadsheetUrl = process.argv[2];
  const name = process.argv[3] || 'My Sheet API';

  if (!spreadsheetUrl) {
    console.error('Usage: npm run seed -- <google-sheet-url-or-id> [name]');
    console.error('Example: npm run seed -- "https://docs.google.com/spreadsheets/d/1abc.../edit" "Products"');
    process.exit(1);
  }

  // Extract spreadsheet ID from URL or use as-is
  const match = spreadsheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const spreadsheetId = match ? match[1] : spreadsheetUrl;

  const sheetApi = await prisma.sheetApi.create({
    data: {
      name,
      spreadsheetId,
    },
  });

  console.log('✅ SheetApi created!');
  console.log(`   ID:             ${sheetApi.id}`);
  console.log(`   Name:           ${sheetApi.name}`);
  console.log(`   Spreadsheet ID: ${sheetApi.spreadsheetId}`);
  console.log(`   Endpoint:       GET http://localhost:3000/api/v1/${sheetApi.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
