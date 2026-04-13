# Getting Started

sheets.banco turns your Google Sheets into REST APIs. This guide walks you through setting up your own instance.

## Prerequisites

- Node.js 18+
- PostgreSQL database
- Google Cloud project with Sheets API enabled
- Google service account with JSON key

## 1. Clone the repository

```bash
git clone https://github.com/matheusnorjosa/sheets.banco.git
cd sheets.banco
npm install
```

## 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/sheets_banco"
GOOGLE_SERVICE_ACCOUNT_EMAIL="your-sa@project.iam.gserviceaccount.com"
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
JWT_SECRET="a-random-string-at-least-16-chars"
PORT=3000
```

## 3. Set up the database

```bash
npx prisma db push --schema prisma/schema.prisma
```

## 4. Start the API server

```bash
npm run dev
```

The API is now running at `http://localhost:3000`.

## 5. Start the dashboard (optional)

```bash
npm run dev:web
```

The dashboard is available at `http://localhost:3001`.

## 6. Connect a Google Sheet

1. Share your Google Sheet with the service account email
2. Register via the dashboard or use the seed script:

```bash
npm run seed -- "https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit" "My API"
```

3. Use the returned API ID to access your data:

```bash
curl http://localhost:3000/api/v1/YOUR_API_ID
```

## Google Service Account Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select existing)
3. Enable the **Google Sheets API**
4. Go to **IAM & Admin > Service Accounts**
5. Create a service account
6. Create a JSON key and download it
7. Copy the `client_email` to `GOOGLE_SERVICE_ACCOUNT_EMAIL`
8. Copy the `private_key` to `GOOGLE_PRIVATE_KEY`
9. Share your Google Sheets with the service account email (as Editor)
