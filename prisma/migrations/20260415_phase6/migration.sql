-- Phase 6: Computed Fields, Snapshots, Scheduled Sync, Multi-Spreadsheet

-- Add sync and auto-snapshot fields to SheetApi
ALTER TABLE "SheetApi" ADD COLUMN "syncEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SheetApi" ADD COLUMN "syncCron" TEXT;
ALTER TABLE "SheetApi" ADD COLUMN "autoSnapshotOnWrite" BOOLEAN NOT NULL DEFAULT false;

-- ComputedField
CREATE TABLE "ComputedField" (
    "id" TEXT NOT NULL,
    "sheetApiId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "expression" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComputedField_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComputedField_sheetApiId_name_key" ON "ComputedField"("sheetApiId", "name");
ALTER TABLE "ComputedField" ADD CONSTRAINT "ComputedField_sheetApiId_fkey" FOREIGN KEY ("sheetApiId") REFERENCES "SheetApi"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Snapshot
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL,
    "sheetApiId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "headers" TEXT[],
    "rowCount" INTEGER NOT NULL,
    "sheetName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Snapshot_sheetApiId_version_key" ON "Snapshot"("sheetApiId", "version");
CREATE INDEX "Snapshot_sheetApiId_createdAt_idx" ON "Snapshot"("sheetApiId", "createdAt");
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_sheetApiId_fkey" FOREIGN KEY ("sheetApiId") REFERENCES "SheetApi"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AdditionalSheet
CREATE TABLE "AdditionalSheet" (
    "id" TEXT NOT NULL,
    "sheetApiId" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdditionalSheet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdditionalSheet_sheetApiId_spreadsheetId_key" ON "AdditionalSheet"("sheetApiId", "spreadsheetId");
ALTER TABLE "AdditionalSheet" ADD CONSTRAINT "AdditionalSheet_sheetApiId_fkey" FOREIGN KEY ("sheetApiId") REFERENCES "SheetApi"("id") ON DELETE CASCADE ON UPDATE CASCADE;
